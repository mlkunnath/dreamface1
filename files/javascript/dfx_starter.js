/*
 This notice must be untouched at all times.

 DreamFace DFX
 Version: 2.0.0
 Author: Interactive Clouds

 Copyright (c) 2015 Interactive Clouds, Inc.  "DreamFace" is a trademark of Interactive Clouds, Inc.

 LICENSE: DreamFace Open License
 */
var path = require('path');

var dreamface = require('./dfx')
    .init({
     authConfPath : path.resolve(__dirname, './lib/auth/.auth.conf')
    })
    .start();


