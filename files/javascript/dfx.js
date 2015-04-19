/*
 This notice must be untouched at all times.

 DreamFace DFX
 Version: 2.0.0
 Author: Interactive Clouds

 Copyright (c) 2015 Interactive Clouds, Inc.  "DreamFace" is a trademark of Interactive Clouds, Inc.

 LICENSE: DreamFace Open License
 */

// Declaration of main modules

var validator;
var SETTINGS = require('./lib/dfx_settings');
var passport = require('passport');
var request = require('request');
var LocalStrategy = require('passport-local').Strategy;
var DigestStrategy = require('passport-http').DigestStrategy;
var BasicStrategy = require('passport-http').BasicStrategy;
var express = require('express');
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var path = require('path');
var fs = require('fs');
var Q = require('q');
var sockets = require('./lib/dfx_sockets');
var version = require('./package.json').version;
var isPortFree = require('./lib/utils/isPortFree');

var out = module.exports = {},
    Log,
    log,
    isInited = false,
    host_app,
    server;

var key = process.argv[2];


out.registerTheme = function( theme_name, theme ) {

    SETTINGS.templates[theme_name] = theme;
    console.log( 'Theme ' + theme_name + ' has been registered' );

};

// TODO object instead of arguments??
out.init = function ( app, host_server, settings ) {

    if ( isInited ) throw('Init can be invoked only once.');

    if ( host_server ) server = host_server;
    if ( app ) host_app = app;

    var l; // local settings
    
    try { l = require('./lib/dfx_settings.local.js') } catch (e) {}

    if ( l ) overwriteSettings(SETTINGS, l);
    if ( settings ) overwriteSettings(SETTINGS, settings);

    isInited = true;


    Log = require('./lib/utils/log');
    if ( SETTINGS.logging.stdout ) Log.init.stdout(SETTINGS.logging.stdout);
    if ( SETTINGS.logging.file   ) {
        SETTINGS.logging.file.path = path.join(__dirname, SETTINGS.logging.file.path);
        Log.init.file(  SETTINGS.logging.file);
    }
    log = new Log.Instance({label:'DFX_MAIN'});

    return out;


    /**
     * deep overwrite a with params of b
     * BUT arrays will be overwritten wholly
     *
     * @param {Object} a object to overwrite
     * @param {Object} b with params of the object a will be overwritten
     */
    function overwriteSettings ( a, b, path ) {

        path = path || [];
    
        for ( var param in b ) {
    
            if ( !a.hasOwnProperty(param) ) {
                throw('Unknown parameter ' + path.concat(param).join('.'));
            }
    
            if ( typeof b[param] !== 'object' || b[param] instanceof Array ) {
                a[param] = b[param];
            } else {
                overwriteSettings(a[param], b[param], path.concat(param));
            }
        }
    }
};

var sysadmin;
out.start = function () {

    if ( !isInited ) out.init();

    return isPortFree(SETTINGS.server_host, SETTINGS.server_port) // TODO it'll not works if there is host_app
    .then(function () {

        validator = require('./lib/dfx_validator');

        if (key) {

            if (key !== "-v") throw("Unknown key "+key);

            return validator.getVersionInfo()
            .then(function(){
                process.exit();
            });
        }

    })
    .then(function(){
        sysadmin = require('./lib/dfx_sysadmin');

        return require('./lib/auth/utils')
        .initCheck()
        .then(sysadmin.cloudRepository.get)
        .then(function(repository){
            return repository && repository.version && validator.executePatches();
        })
        .then(_start);
    }).done();
}


function _start () {

    // mongodb-settings depended modules,
    // it should be required after setting mongo_host, mongo_port
    var proxy = require('./lib/dfx_proxy');

    passport.use(new DigestStrategy({ qop: 'auth', realm: 'application' },
        function( complexName, done ) {
            complexName = complexName.split('::');

            var tenant      = complexName[0],
                application = complexName[1],
                login       = complexName[2],
                role        = complexName[3];

            return sysadmin.tenant.user.get(tenant, login)
            .then(function( u ){
                role = role || u.roles['default'];

                if ( !~u.roles.list.indexOf(role) ) return done(null, false);

                return sysadmin.tenant.role.getRights({role:role, tenant:tenant})
                .then(function(rights){
                    var user = {
                        tenant      : tenant,
                        application : application,
                        login       : login,
                        role        : role,
                        rights      : rights,
                        email       : u.email,
                        lastName    : u.lastName,
                        firstName   : u.firstName,
                        _id         : u['_id']
                    };
                    done(null, user, u.password);
                })
            })
            .fail(done)
            .done();
        },
        function(params, done) {
            // TODO
            done(null, true)
        }
    ));


    passport.use(new BasicStrategy(
        function(tenantName, token, done) {
            sysadmin.tenant.get(tenantName)
            .then(function(tenant){
                    if (!tenant || tenant.length === 0) { return done(null, false); }
                    var user = {
                        "id": tenantName,
                        "token": Object.keys(tenant.databaseTokens)[0]
                    };
                    return token === user.token
                        ? done(null, user)
                        : done(null, false);
                },
                function () { done(null, false) }
            ).done();
        }
    ));

    var app = host_app || require('express')();

    if ( !host_app ) {
        if ( process.env.DFX_HTTPS ) {

            server = require('https').createServer(
                {
                    key  : fs.readFileSync(
                        './certs/server.key', 'utf8'
                    ),
                    cert : fs.readFileSync(
                        './certs/server.crt', 'utf8'
                    )
                },
                app
            );
            log.ok('Server is run in HTTPS mode.')

        } else {

            server = require('http').createServer(app);
            log.warn('Server is run in HTTP mode.')

        }
    }

    var io = require('socket.io').listen(server, { log: false });

    if ( SETTINGS.logging.server ) {
        var settings = Object.create(SETTINGS.logging.server);
        settings.socket = io.of('/logserver');

        Log.init.server(settings);
        Log.startServer();
    }

    app.set('views', path.join(__dirname, 'templates'));
    app.set('view engine', 'jade');
    app.use("/deploy", express.static(path.join(__dirname, 'deploy')));
    app.use("/all", express.static(path.join(__dirname, 'public/all')));
    app.use("/bootstrap", express.static(path.join(__dirname, 'public/bootstrap')));
    app.use("/web", express.static(path.join(__dirname, 'public/web')));
    app.use("/mobile", express.static(path.join(__dirname, 'public/mobile')));
    app.use("/js", express.static(path.join(__dirname, 'public/js')));
    app.use("/styles", express.static(path.join(__dirname, 'public/styles')));
    app.use("/studio/css", express.static(path.join(__dirname, 'studio/css')));
    app.use("/studio/fonts", express.static(path.join(__dirname, 'studio/fonts')));
    app.use("/studio/js", express.static(path.join(__dirname, 'studio/js')));
    app.use("/studio/widget/js/gcontrols", express.static(path.join(__dirname, 'studio/js/gcontrols')));
    app.use("/studio/images", express.static(path.join(__dirname, 'studio/images')));
    app.use("/studio/help", express.static(path.join(__dirname, 'studio/help')));
    app.use("/resources", express.static(path.join(__dirname, 'resources')));
    app.use("/widgets", express.static(path.join(__dirname, 'widgets')));
    app.use(bodyParser.urlencoded({extended: true, limit:'50mb', parameterLimit:'Infinity'}));
    app.use(bodyParser.json({limit:'50mb'}));
    app.use(cookieParser());

    // ================================================================================================
    // TODO =================================================================================== remove!
    app.use(function(req, res, next){

        var orig = req.header;

        req.header = function ( aName ) {
            if ( aName === SETTINGS.authSiteminderHeaderName ) return 'juner@surr.name';
            return orig.apply(req,arguments);
        };

        next();
    });
    // TODO =================================================================================== remove!
    // ================================================================================================

    var auth = require('./lib/auth'),
        gate = auth.gate;

    app.use("/console/logfile", gate.consoleStatic);
    app.use("/console/logfile", express.static(path.join(__dirname, 'logs')));

    app.use(passport.initialize());
    //app.use(passport.session());
    app.use( function(req, res, next){
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers",  'WWW-Authenticate, Authorization, Accept');
        res.setHeader("Access-Control-Expose-Headers", 'WWW-Authenticate, Authorization, Accept');
        res.setHeader('Access-Control-Allow-Methods', 'PUT, GET, POST, DELETE, OPTIONS');
        next();
    });


    var mdbw = require('./lib/mdbw')(SETTINGS.mdbw_options);

    function addActiveRepositoryToSession ( req, done ) {

        var prefix   = SETTINGS.databases_tenants_name_prefix,
            tenantid = req.session.tenant.id;

        Q.when( mdbw.get(prefix + tenantid, 'versioning_providers'),
            function(docs){
                req.session.activeRepository = docs.length ? docs[0].repository : '';
                done();
            }
        );
    }

    auth.whenAppUserIsLoggedIn(   addActiveRepositoryToSession);
    auth.whenStudioUserIsLoggedIn(addActiveRepositoryToSession);



    // Socket Initialization
    sockets.init(io);


    // Proxy Initialization
    proxy.initialize(app);

    if ( !host_app ) {
        server.listen(SETTINGS.server_port, SETTINGS.server_host);
        console.log( 'DreamFace starts ' + ( process.env.DFX_HTTPS ? 'HTTPS' : 'HTTP' ) + ' listener.');
    }

    // Application Server Start
    console.log('------------------------------------------------------');
    console.log('Starting DreamFace X-Platform on port %s', SETTINGS.server_port);
    console.log('v%s', version);
    console.log('Copyright (c) 2015 Interactive Clouds, Inc.');
    console.log('"DreamFace" is a trademark of Interactive Clouds, Inc.');
    console.log('http://www.interactive-clouds.com');
    console.log('------------------------------------------------------');

    //  Verifying External Server Host
    validator.verifyExternalHostValue();


    // init cloud repository if is not inited yet
    sysadmin.cloudRepository.get()
    .then(function(repository){

        if ( repository && repository.version ) return;

        // is not inited
        log.warn('Cloud repository is not initialized. Trying to initialize...');
        sysadmin.cloudRepository.init()
        .then(
            function(){ log.ok('Cloud repository is initialized.') },
            function(error){ log.fatal('Can not initialize cloud repository: ' + error) }
        )
    });
}

if ( !module.parent ) out.start();
