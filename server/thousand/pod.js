'use strict';

var Rx = require('rx')
  , RxNode = require('rx-node')
  , split = require('split')
  , request = require('request')
  , _ = require('underscore')
  , PodParser = require('./pod-parser')
  , http = require('http')
  , hexboards = require('./hexboards')
  ;

var tag = 'POD';

// Config
var config = {
  live: {
    oauthToken: process.env.ACCESS_TOKEN_LIVE || false,
    namespace: process.env.NAMESPACE_LIVE || 'demo1', //summit1
    openshiftServer: process.env.OPENSHIFT_SERVER_LIVE || 'openshift-master.summit2.paas.ninja:8443',
    proxy: process.env.PROXY_LIVE || 'http://sketch.demo.apps.summit2.paas.ninja'
  },
  preStart: {
    oauthToken: process.env.ACCESS_TOKEN_PRESTART || false,
    namespace: process.env.NAMESPACE_PRESTART || 'demo-test',  //summit2
    openshiftServer: process.env.OPENSHIFT_SERVER_PRESTART || 'openshift-master.summit3.paas.ninja:8443',
    // proxy: process.env.PROXY || 'http://openshiftproxy-bleathemredhat.rhcloud.com'
    proxy: process.env.PROXY_PRESTART || 'http://sketch.demo.apps.summit3.paas.ninja'
  }
};

// Allow self-signed SSL
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

var buildWatchPodsUrl = function(server, namespace) {
  return 'https://' + server + '/api/v1beta3/watch/namespaces/' + namespace + '/pods';
};

var buildListPodsUrl = function(server, namespace) {
  return 'https://' + server + '/api/v1beta3/namespaces/' + namespace + '/pods';
};

var optionsBase = {
    method : 'get'
  , url    : null
  , qs     : {}
  , rejectUnauthorized: false
  , strictSSL: false
  , auth   : null
};

var listWatchAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 8
});

var environments = {
  live: {
    name: 'live'
  , listOptions: _.defaults({
      url: buildListPodsUrl(config.live.openshiftServer, config.live.namespace)
    , auth: {bearer:  config.live.oauthToken}
    , pool: listWatchAgent
    }, optionsBase)
  , watchOptions: _.defaults({
      url: buildWatchPodsUrl(config.live.openshiftServer, config.live.namespace)
    , auth: {bearer:  config.live.oauthToken}
    , pool: listWatchAgent
    }, optionsBase)
  , state: {first  : true, pods: {}}
  , config: config.live
  , subjects: _.range(1026).map(function(index) {
      return new Rx.ReplaySubject(1);
    })
  , hexboard: hexboards.liveBoard
  }
, preStart: {
    name: 'preStart'
  , listOptions: _.defaults({
      url: buildListPodsUrl(config.preStart.openshiftServer, config.preStart.namespace)
    , auth: {bearer:  config.preStart.oauthToken}
    , pool: listWatchAgent
    }, optionsBase)
  , watchOptions: _.defaults({
      url: buildWatchPodsUrl(config.preStart.openshiftServer, config.preStart.namespace)
    , auth: {bearer:  config.preStart.oauthToken}
    , pool: listWatchAgent
    }, optionsBase)
  , state: {first  : true, pods: {}}
  , config: config.preStart
  , subjects: _.range(1026).map(function(index) {
      return new Rx.ReplaySubject(1);
    })
  , hexboard: hexboards.preStartBoard
  }
};

environments.live.parser = new PodParser(environments.live);
environments.preStart.parser = new PodParser(environments.preStart);

var verifyAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 5
});

function verifyPodAvailable(parsed, timeout) {
  var pod = parsed.data;
  return Rx.Observable.create(function(observer) {
    var options = {
      url: pod.url + 'status'
    , method: 'get'
    , timeout: timeout || 20000
    , pool: verifyAgent
    }
    // console.log(tag, 'Verifying', options.url);
    request(options, function(error, response, body) {
      if (!error && response && response.statusCode == 200) {
        if (pod.errorCount) {
          console.log(tag, 'Recovery (#', pod.errorCount, ')', parsed.object.metadata.name);
          delete(pod.errorCount);
        }
        observer.onNext(parsed);
        observer.onCompleted();
      } else {
        var err = {
          code: response ? response.statusCode : ''
        , url: options.url
        , msg: error
        , pod: pod
        }
        observer.onError(err);
      };
    })
  })
};

function retryVerification(maxRetries) {
  return function(errors) {
    return errors.scan(0, function(errorCount, err) {
      if (errorCount === 0) {
        var msg = err.code ? err.code + ': Error' : 'Error';
        console.log(tag, msg, err.url);
      };
      if (err.code && (err.code === 401 || err.code === 403)) {
        return maxRetries;
      };
      err.pod.errorCount = ++errorCount;
      if (errorCount > maxRetries) {
        var msg = 'Error: maxRetries exceeded ' + err.url;
        console.log(tag, msg);
        throw new Error(msg);
      }
      return errorCount;
    })
    .flatMap(function(errorCount) {
      return Rx.Observable.timer(errorCount * 250);
    });
  }
}

var list = function(env) {
  return Rx.Observable.create(function(observer) {
    delete env.watchOptions.qs.latestResourceVersion;
    console.log(tag, 'list options', env.listOptions.url);
    var stream = request(env.listOptions, function(error, response, body) {
      if (error) {
        console.log(tag, 'error:',error);
        observer.onError(error);
      } else if (response && response.statusCode === 200) {
        var json = JSON.parse(body);
        json.timestamp = new Date();
        observer.onNext(json.items);
        observer.onCompleted();
      } else {
        observer.onError({
          code: response.statusCode
        , options: env.listOptions
        , msg: body
        });
      }
    });
  })
  .flatMap(function(pods) {
    return pods;
  })
  .flatMap(function(object) {
    var pod = {type: 'List Result', object: object};
    env.watchOptions.qs.latestResourceVersion = pod.object.metadata.resourceVersion;
    var name = pod.object.metadata.name;
    var oldPod = env.state.pods[name];
    if (!oldPod || oldPod.object.metadata.resourceVersion != pod.object.metadata.resourceVersion) {
      env.state.pods[name] = pod;
      return [pod];
    }
    else {
      return [];
    }
  })
}

var watch = function(env) {
  return Rx.Observable.create(function(observer) {
    console.log(tag, 'list options', env.watchOptions.url, env.watchOptions.qs);
    var stream = request(env.watchOptions);
    stream.on('error', function(error) {
      console.log(tag, 'error:', error);
      observer.onError(error);
    });
    stream.on('end', function() {
      observer.onError({type: 'end', msg: 'Request terminated.'});
    });
    var lines = stream.pipe(split());
    stream.on('response', function(response) {
      if (response.statusCode === 200) {
        console.log(tag, 'Connection success', env.name);
        observer.onNext(lines)
      } else {
        response.on('data', function(data) {
          var message;
          try {
            var data = JSON.parse(data);
            message = data.message;
          } catch(e) {
            message = data.toString();
          }
          var error = {
            code: response.statusCode
          , options: env.watchOptions
          , message: message
          };
          if (error.code === 401 || error.code === 403) {
            error.type = 'auth';
          };
          console.log(tag, error);
          observer.onError(error);
        });
      };
    });
  })
  .flatMap(function(stream) {
    return RxNode.fromStream(stream)
  })
  .flatMap(function(data) {
    try {
      var pod = JSON.parse(data);
      pod.timestamp = new Date();
      var name = pod.object.metadata.name;
      var oldPod = env.state.pods[pod.object.metadata.name];
      if (!oldPod || oldPod.object.metadata.resourceVersion != pod.object.metadata.resourceVersion) {
        env.state.pods[name] = pod;
        return [pod];
      }
      else {
        return [];
      }
    } catch(e) {
      console.log(tag, 'JSON parsing error:', e);
      console.log(data);
      return [];
    }
  })
};

var listWatch = function(env) {
  return list(env).toArray().flatMap(function(pods) {
    if (pods.length) {
      var last = pods[pods.length - 1];
    }
    return Rx.Observable.merge(
      Rx.Observable.fromArray(pods)
    , watch(env)
    );
  });
};

var watchStream = function(env) {
  return listWatch(env).retryWhen(function(errors) {
    return errors.scan(0, function(errorCount, err) {
      console.log(tag, new Date());
      console.log(tag, 'Connection error:', err)
      if (err.type && err.type === 'end') {
        console.log(tag, 'Attmepting a re-connect (#' + errorCount + ')');
        return errorCount + 1;
      } else {
        throw err;
      }
    });
  })
};

var parseStream = function(env) {
  return watchStream(env).map(function(json) {
    return env.parser.parseData(json, true);
  })
  .filter(function(parsed) {
    return parsed && parsed.data && parsed.data.type && parsed.data.id <= 1025;
  })
}

var verifyStream = function(env) {
  return parseStream(env).flatMap(function(parsed) {
    if (parsed.data.stage != 4) {
      return Rx.Observable.just(parsed);
    } else {
      return Rx.Observable.merge(
        Rx.Observable.just(parsed)
      , verifyPodAvailable(parsed, 20000)
        .retryWhen(retryVerification(5))
        .catch(Rx.Observable.empty())
        .filter(function(parsed) {
          return parsed;
        })
        .map(function(parsed) {
          var newParsed = _.clone(parsed)
          newParsed.data = _.clone(parsed.data);
          newParsed.data.stage = 5;
          env.hexboard.assignPod(parsed);
          // env.state.pods[newParsed.object.metadata.name] = newParsed;
          return newParsed;
        })
      );
    };
  })
  .tap(function(parsed) {
    var subject = env.subjects[parsed.data.id];
    subject.onNext(parsed);
    if (parsed.data.stage === 0) {
      subject.onCompleted();
      env.hexboard.dropPod(parsed);
      env.subjects[parsed.data.id] = new Rx.ReplaySubject(1);
    }
  })
  .publish();
};

verifyStream(environments.live).connect();
verifyStream(environments.preStart).connect();

var liveStream = Rx.Observable.merge(environments.live.subjects)
var preStartStream = Rx.Observable.merge(environments.preStart.subjects);

var watchStream = function(env, stream) {
  return Rx.Observable.interval(100)
    .flatMap(function(index) {
      var n = index % 1026;
      return stream.skip(n).take(1)
    })
    .filter(function(pod) {
      return pod.data.stage >= 4;
    })
    .flatMap(function(pod) {
      return Rx.Observable.return(pod).flatMap(function(pod) {
        return verifyPodAvailable(pod, 2000)
        .tap(function(pod) {
          var subject = env.subjects[pod.data.id];
          if (pod.data.stage !== 5) {
            console.log(pod.data.name, 'came alive');
            var newPod = _.clone(pod)
            newPod.data = _.clone(pod.data);
            newPod.data.stage = 5;
            subject.onNext(newPod);
          }
        })
        .tapOnError(function(err) {
          var subject = env.subjects[pod.data.id];
          if (pod.data.stage === 5) {
            console.log(pod.data.name, 'no longer responding');
            var newPod = _.clone(pod)
            newPod.data = _.clone(pod.data);
            newPod.data.stage = 4;
            subject.onNext(newPod);
          } else {
            console.log(pod.data.name, 'still not responding');
          }
        })
      })
      .retryWhen(retryVerification(10))
      .catch(Rx.Observable.return(pod));
    })
    .subscribeOnError(function(err) {
      console.log(error);
    });
};

// Rx.Observable.return(0).delay(40000).subscribe(function() { // when all initial checks are done
//   var watchSubscription = watchStream(environments.preStart, preStartStream);
// });

module.exports = {
  liveStream: liveStream
, preStartStream: preStartStream
};
