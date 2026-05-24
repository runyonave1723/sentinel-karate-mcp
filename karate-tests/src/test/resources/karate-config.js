function fn() {
  var env = karate.env || 'dev';
  karate.log('Running in environment:', env);

  var config = {
    env: env,
    baseUrl: 'http://localhost:8090'
  };

  if (env === 'dev') {
    config.baseUrl = 'http://localhost:8090';
  } else if (env === 'qa') {
    config.baseUrl = 'http://localhost:8091';
  } else if (env === 'prod') {
    config.baseUrl = 'http://prod-server:8090';
  }

  karate.configure('connectTimeout', 5000);
  karate.configure('readTimeout', 10000);

  return config;
}
