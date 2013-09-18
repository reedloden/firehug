'use strict';

var express = require('express');
var http = require('http');
var io = require('socket.io');
var https = require('https');
var querystring = require('querystring');
var hbs = require('hbs');
var stylus = require('stylus');
var nib = require('nib');
var connect = require('connect');
var cookie = require('connect').utils;
var request = require('request');
var redis = require('redis');
var nconf = require('nconf');

// Job scheduler
require('./bin');

nconf.argv().env().file({
  file: 'local.json'
});

function getRedisClient() {
  if (process.env.VCAP_SERVICES) {
    var redisconf = JSON.parse(process.env.VCAP_SERVICES).redis[0].credentials;
    var db = redis.createClient(redisconf.port,
      redisconf.host);
    db.auth(redisconf.password);
  } else {
    var db = redis.createClient();
  }
  return db;
}
var client = getRedisClient();

var app = express();

// Setup express
if (!process.NODE_ENV) {
  app.use(express.logger());
}
app.use(express.bodyParser());
var cookieParser = express.cookieParser(nconf.get('sessionSecret'));
app.use(cookieParser);

app.use(stylus.middleware({
  src: __dirname + '/public',
  compile: function compile(str, path) {
    return stylus(str)
      .set('filename', path)
      .use(nib());
  }
}));
app.use(express.static(__dirname + '/public'));

// Template engine
app.set('view engine', 'html');
app.set('views', __dirname + '/views');
// hbs.registerPartials(__dirname + '/views/partials');
app.engine('html', hbs.__express);

// Define storage object and cookie name for later use
var sessionStore = new connect.session.MemoryStore();
app.use(express.session({
  key: nconf.get('sessionName'),
  store: sessionStore
}));

app.get('/', function(request, response) {
  if (!nconf.get('audience')) {
    nconf.set('audience', request.headers.host);
  }
  var payload = {};
  if (request.session.email) {
    console.log('/', request.session.email);
    payload.user = {
      email: request.session.email
    };
  }

  response.render('index', {
    jsonPayload: JSON.stringify(payload)
  });
});

// DEPRECATED: Remove when hugs got merged/killed
app.get('/hugs', function(request, response) {
  if (!nconf.get('audience')) {
    nconf.set('audience', request.headers.host);
  }
  response.render('hugs/index');
});

app.post('/verify', function(request, response) {
  console.log('/verify', !! request.body.assertion);

  var assertion = request.body.assertion;
  if (!assertion) {
    response.status(400).send({
      error: 'No assertion'
    });
  }
  console.log('Verifying with %s', nconf.get('audience'));
  Users.emailFromAssertion(assertion, nconf.get('audience'), function(err, result) {
    if (err) {
      console.log('Users.emailFromAssertion failed', err);
      return response.status(400).send({
        error: 'Invalid assertion'
      });
    }
    console.log('Users.login', result.email);
    request.session.email = result.email || false;

    Users.login(request.session, result.email, function(err, user) {
      if (err || !user) {
        console.log('Users.login failed', err);
        return response.status(400).send({
          error: 'User not found'
        });
      }
      console.log('Users.login success', user);
      response.send({
        status: 1,
        user: {
          email: request.session.email
        }
      });
    });
  });
});

app.get('/schedule', function(request, response) {
  if (!request.session.email) {
    return response.status(401).send({
      status: 0
    });
  }

  response.send({
    schedule: [{

    }]
  });
});

app.post('/logout', function(request, response) {
  console.log('/logout', request.session ? request.session.email : 'none');
  request.session.destroy();
  response.status(200).send();
});

// FIXME: This is just an example
app.get('/realmozillians', function(req, res) {
  console.log('query %j', req.query);
  var users = [];

  client.smembers('emails', function(err, emails) {
    if (err) {
      res.status = 400;
      res.send(err);
    } else {

      for (var email in emails) {
        client.hgetall('user:' + emails[email], function(err, user) {
          if (err) {
            res.status = 400;
            res.json({
              error: err
            });
          } else {
            users.push(user);
          }

          if (users.length === emails.length) {
            res.send(users);
          }
        });
      }
    }
  });
});


// Start express server
var server = http.createServer(app);
server.listen(process.env.PORT || 5000, function() {
  console.log('Listening on %j', server.address());
});


// Start socket.io server
var sio = io.listen(server);

sio.configure(function() {
  sio.set('transports', ['xhr-polling']);
  sio.set('polling duration', 20);
});

var sockets = {};

var persistent = {
  users: {},
  announces: [],
  ignitions: []
};

function broadcastStatus() {
  sio.sockets.emit('status', {
    online: Object.keys(sockets).length
  });
}

// Via https://gist.github.com/bobbydavid/2640463
sio.set('authorization', function(data, accept) {
  cookieParser(data, {}, function(err) {
    if (err) {
      return accept(err, false);
    }
    var sid = data.sessionId = data.signedCookies[nconf.get('sessionName')];

    sessionStore.get(sid, function(err, session) {
      if (err || !session) {
        return accept('unauthorized', false);
      }
      session.sessionId = sid;
      data.session = session;

      sessionStore.set(sid, session, function() {
        accept(null, true);
      });
    });
  });
});

sio.on('connection', function(socket) {
  var sid = socket.handshake.sessionId;
  session = socket.handshake.session;
  var user;

  console.log('Socket %s connected', sid);

  sockets[sid] = socket;

  if (session.email) {
    Users.login(session.email, function(err, userRecord) {
      user = userRecord;
      socket.emit('hello', {
        email: session.email
      });
    });
  } else {
    socket.emit('hello', {});
  }

  broadcastStatus();

  socket.on('assertLogin', function(data) {
    Users.emailFromAssertion(data.assertion, nconf.get('audience'), function(err, result) {
      console.log(err, result);
      if (err) {
        socket.emit('login', {
          email: null
        });
        return;
      }
      var email = result.email;

      Users.login(session, email, function(err, user) {
        socket.emit('login', {
          email: user.email
        });
      });
    });
  });

  socket.on('announce', function(announceEnd) {
    var email = session.email;
    var time = Date.now();

    persistent.announces.push({
      email: email,
      time: time
    });

    var treshold = nconf.get('treshold');
    // Initial set
    var seeds = persistent.announces.filter(function(other) {
      return other.email != email && (time - other.time) < treshold;
    }).map(function(other) {
      Users.findByEmail(other.email, function(err, result) {
        if (err || !result || !result.socket) {
          return;
        }
        if (result.user.announceResults) {
          result.user.announceResults.push(email);
        } else {
          result.user.announceResults = [email];
        }
        console.log('*** Past', other.email, email);
        var otherSocket = result.socket;
        otherSocket.emit('findings', {
          emails: [email]
        });
      });
      return other.email;
    });

    user.announceResults = seeds;

    console.log('*** Seeds', seeds);
    socket.emit('findings', {
      emails: seeds
    });
    if (announceEnd) {
      setTimeout(function() {
        announceEnd({
          count: user.announceResults.length
        });
      }, treshold);
    }
  });

  socket.on('disconnect', function() {
    delete sockets[sid];
    var user = persistent.users[session.email];
    if (user) {
      user.sessionId = null;
    }
    broadcastStatus();
  });
});

var Users = {

  emailFromAssertion: function(assertion, audience, next) {
    var vreq = https.request({
      host: 'login.persona.org',
      path: '/verify',
      method: 'POST'
    }, function(vres) {
      var body = '';
      vres.on('data', function(chunk) {
        body += chunk;
      }).on('end', function() {
        try {
          var verifierResp = JSON.parse(body);
          var valid = verifierResp && verifierResp.status === 'okay';
          if (!valid) {
            next(new Error('failed to verify assertion: ' + verifierResp.reason));
            return;
          }
          next(null, {
            email: verifierResp.email
          });
        } catch (e) {
          next(new Error('non-JSON response from verifier: ' + e));
        }
      });
    });
    vreq.setHeader('Content-Type', 'application/x-www-form-urlencoded');

    var data = querystring.stringify({
      assertion: assertion,
      audience: audience
    });
    vreq.setHeader('Content-Length', data.length);
    vreq.write(data);
    vreq.end();
  },

  findByEmail: function(email, next) {
    if (!user || !user.sessionId) {
      next(new Error('Not found'));
    }
    next(null, {
      user: user,
      socket: sockets[user.sessionId]
    });
  },

  login: function(session, email, next) {
    client.hgetall('user:' + email, function(err, u) {
      if (err || !u) {
        next(new Error('User not found ', err));
      } else {
        console.log('found email ', email);
        session.email = email;

        var user = {
          fullName: u.fullName,
          email: u.email,
          ircName: u.ircName,
          announceResults: []
        };

        user.sessionId = session.sessionId;

        sessionStore.set(session.sessionId, session, function() {
          next(null, {
            user: user
          });
        });
      }
    });
  }

};
