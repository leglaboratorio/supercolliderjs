
/**
 *
 * sclang - boots a supercollider language interpreter process
 *  and enables stdin/out and system level event responders
 *
 *  SuperCollider comes with an executable called sclang
 *  which can be communicated with via stdin/stdout
 *  or via OSC.
 *
 * methods:
 *   boot  - boot an sclang process
 *   write - write to stdin of the sclang process
 *   quit
 *
 */

var
  _ = require('underscore'),
  EventEmitter = require('events').EventEmitter,
  spawn = require('child_process').spawn,
  path = require('path'),
  uuid = require('node-uuid'),
  join = require('path').join,
  yaml = require('js-yaml'),
  temp = require('temp'),
  fs   = require('fs'),
  untildify = require('untildify');

import Logger from '../utils/logger';
import {SclangIO, STATES} from './internals/sclang-io';
import resolveOptions from '../utils/resolveOptions';
import {Promise} from 'bluebird';


export default class SCLang extends EventEmitter {

  /*
   * @param {object} options - sclang command line options
   */
  constructor(options={}) {
    super();
    this.options = options || {};
    this.process = null;
    this.log = new Logger(this.options.debug, this.options.echo);
    this.log.dbug(this.options);
    this.stateWatcher = this.makeStateWatcher();
  }

  /**
   * build args for sclang
   *
   *   -d <path>                      Set runtime directory
   *   -D                             Enter daemon mode (no input)
   *   -g <memory-growth>[km]         Set heap growth (default 256k)
   *   -h                             Display this message and exit
   *   -l <path>                      Set library configuration file
   *   -m <memory-space>[km]          Set initial heap size (default 2m)
   *   -r                             Call Main.run on startup
   *   -s                             Call Main.stop on shutdown
   *   -u <network-port-number>       Set UDP listening port (default 57120)
   *   -i <ide-name>                  Specify IDE name (for enabling IDE-specific class code, default "none")
   *   -a                             Standalone mode
   */
  args(options) {
    var o = [];
    o.push('-i', 'supercolliderjs');
    if (options.executeFile) {
      o.push(options.executeFile);
    }
    o.push('-u', options.langPort);
    if (options.config) {
      o.push('-l', options.config);
    }
    return o;
  }


  /**
   * makeSclangConfig
   *
   * make sclang_config.yaml as a temporary file
   * with the supplied values
   *
   * This is the config file that sclang reads, specifying
   * includePaths and excludePaths
   *
   * @param {object} config - options to write to file
   * @returns {Promise} resolving with the path of the temp config file
   */
  makeSclangConfig(config) {
    /**
      write options as yaml to a temp file
      and return the path
    **/
    return new Promise((resolve, reject) => {
      var str = yaml.safeDump(config, {indent: 4});

      temp.open('sclang-config', function(err, info) {
        if (err) {
          return reject(err);
        }
        fs.write(info.fd, str);
        fs.close(info.fd, function(err) {
          if (err) {
            reject(err);
          } else {
            resolve(info.path);
          }
        });
      });
    });
  }


  /**
   * boot
   *
   * start sclang as a subprocess
   *
   * @returns {Promise}
   */
  boot() {
    this.setState(STATES.BOOTING);

    // merge supercollider.js options with any sclang_conf
    var config = this.sclangConfigOptions(this.options);

    return this.makeSclangConfig(config)
      .then((configPath) => {
        return this.spawnProcess(this.options.sclang, _.extend({}, this.options, {config: configPath}));
      });
  }

  /**
   * spawnProcess - starts the sclang executable
   *
   * sets this.process
   * adds state listeners
   *
   * @param {string} execPath - path to sclang
   * @param {object} commandLineOptions - options for the command line
   *                filtered with this.args so it will only include values
   *                that sclang uses.
   * @returns {Promise}
   *     resolves null on successful boot and compile
   *     rejects on failure to boot or failure to compile the class library
   */
  spawnProcess(execPath, commandLineOptions) {
    return new Promise((resolve, reject) => {
      var done = false;
      this.process = spawn(execPath, this.args(commandLineOptions),
        {
          cwd: path.dirname(execPath)
        });

      var bootListener = (state) => {
        if (state === STATES.READY) {
          done = true;
          this.removeListener('state', bootListener);
          resolve();
        } else if (state === STATES.COMPILE_ERROR) {
          done = true;
          reject(this.stateWatcher.compileErrors);
          this.removeListener('state', bootListener);
          // probably should remove all listeners
        }
      };

      // temporary listener until booted ready or compileError
      // that removes itself
      this.addListener('state', bootListener);

      setTimeout(() => {
        if (!done) {
          this.log.err('Timeout waiting for sclang boot');
          this.stateWatcher.finalizeCompileErrors();
        }
      }, 10000);

      // long term listeners
      this.installListeners(this.process, Boolean(this.options.stdin));
    });
  }


  /**
   * sclangConfigOptions
   *
   * Builds the options that will be written to the config file that is read by sclang
   * If supercolliderjs-conf specifies a sclang_conf path
   * then this is read and any includePaths and excludePaths are merged
   *
   * throws error if config cannot be read
   *
   * @param {object} options - supercolliderJs options
   * @returns {object} - sclang_config variables
   */
  sclangConfigOptions(options={}) {
    var
      runtimeIncludePaths = [
        path.resolve(__dirname, '../../lib/sc-classes')
      ],
      sclang_conf = {},
      config = {};

    if (options.sclang_conf) {
      try {
        sclang_conf = yaml.safeLoad(fs.readFileSync(untildify(options.sclang_conf), 'utf8'));
      } catch (e) {
        this.log.err(e);
        throw new Error('Cannot open or read specified sclang_conf ' + options.sclang_conf);
      }
    }

    return {
      includePaths: _.union(sclang_conf.includePaths, options.includePaths, runtimeIncludePaths),
      excludePaths: _.union(sclang_conf.excludePaths, options.excludePaths),
      postInlineWarning: _.isUndefined(options.postInlineWarnings) ?
        Boolean(sclang_conf.postInlineWarnings) :
        Boolean(options.postInlineWarnings)
    };
  }

  makeStateWatcher() {
    var stateWatcher = new SclangIO(this);
    for (let name of ['interpreterLoaded', 'error', 'stdout', 'state']) {
      stateWatcher.on(name, (...args) => {
        this.emit(name, ...args);
      });
    }
    return stateWatcher;
  }

  /**
    * listen to events from process and pipe stdio to the stateWatcher
    */
  installListeners(subprocess, listenToStdin) {
    if (listenToStdin) {
      // stdin of the global top level nodejs process
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        if (chunk) {
          this.write(chunk, null, true);
        }
      });
    }
    subprocess.stdout.on('data', (data) => {
      var ds = String(data);
      this.log.dbug(ds);
      this.stateWatcher.parse(ds);
    });
    subprocess.stderr.on('data', (data) => {
      var error = String(data);
      this.log.stderr(error);
      this.emit('stderr', error);
    });
    subprocess.on('error', (err) => {
      this.log.err('ERROR:' + err, 'error');
      this.emit('stderr', err);
    });
    subprocess.on('close', (code, signal) => {
      this.log.dbug('close ' + code + signal);
      this.emit('exit', code);
      this.setState(null);
    });
    subprocess.on('exit', (code, signal) => {
      this.log.dbug('exit ' + code + signal);
      this.emit('exit', code);
      this.setState(null);
    });
    subprocess.on('disconnect', () => {
      this.log.dbug('disconnect');
      this.emit('exit');
      this.setState(null);
    });
  }

  /**
   * write
   *
   * send a raw string to sclang to be interpreted
   * callback is called after write is complete
   */
  write(chunk, callback, noEcho) {
    if (!noEcho) {
      this.log.stdin(chunk);
    }
    this.log.dbug(chunk);
    this.process.stdin.write(chunk, 'UTF-8');
    // escape character means execute the currently accumulated command line as SC code
    this.process.stdin.write('\x0c', null, callback);
  }

  /**
    * storeSclangConf
    */
  storeSclangConf() {
    // store the original configuration path
    // so that it can be accessed by the modified Quarks methods
    // to store into the correct conf file
    if (this.options.sclang_conf) {
      var configPath = path.resolve(untildify(this.options.sclang_conf));
      var setConfigPath = 'SuperColliderJS.sclangConf = "' + configPath + '";\n\n';
      return this.interpret(setConfigPath, null, true, true, true);
    } else {
      return Promise.resolve(this);
    }
  }

  /**
   * interpret
   *
   * evaluates code in sclang
   * and returns a promise
   *
   * resolves promise with result or rejects with error as JSON
   *
   * @param {String} code
   *        source code to evaluate
   * @param {String} nowExecutingPath
            set thisProcess.nowExecutingPath
   *        for use in a REPL to evaluate text in a file
   *        and let sclang know what file it is executing.
   * @param {Boolean} asString
   *        return result .asString for post window
   *        otherwise returns result as a JSON object
   * @param {Boolean} postErrors
   *        call error.reportError on any errors
   *        which posts call stack, receiver, args, etc
   * @param {Boolean} getBacktrace
   *        return full backtrace
   * @returns {Promise}
   */
  interpret(code, nowExecutingPath, asString, postErrors, getBacktrace) {
    return new Promise((resolve, reject) => {
      var escaped = code
        .replace(/[\n\r]/g, '__NL__')
        .replace(/\\/g, '__SLASH__')
        .replace(/\"/g, '\\"');
      var guid = uuid.v1();

      var args = [
        '"' + guid + '"',
        '"' + escaped + '"',
        nowExecutingPath ? '"' + nowExecutingPath + '"' : 'nil',
        asString ? 'true' : 'false',
        postErrors ? 'true' : 'false',
        getBacktrace ? 'true' : 'false'
      ].join(',');

      this.stateWatcher.registerCall(guid, {resolve: resolve, reject: reject});
      this.write('SuperColliderJS.interpret(' + args + ');', null, true);
    });
  }


  /**
   * executeFile
   */
  executeFile(path) {
    return new Promise((resolve, reject) => {
      var guid = uuid.v1();
      this.stateWatcher.registerCall(guid, {resolve: resolve, reject: reject});
      this.write(`SuperColliderJS.executeFile("${ guid }", "${ path }")`, null, true);
    });
  }

  /**
   * @private
   */
  setState(state) {
    this.stateWatcher.setState(state);
  }

  quit() {
    return new Promise((resolve, reject) => {
      var cleanup = () => {
        this.process = null;
        this.setState(null);
        resolve();
      };
      if (this.process) {
        this.process.once('exit', cleanup);
        // request a polite shutdown
        this.process.kill('SIGINT');
        setTimeout(() => {
          // 3.6.6 doesn't fully respond to SIGINT
          // but SIGTERM causes it to crash
          if (this.process) {
            this.process.kill('SIGTERM');
            cleanup();
          }
        }, 250);
      } else {
        cleanup();
      }
    });
  }
}


/**
  * alternate constructor
  * resolves options, boots and loads interpreter
  *
  * @param {object} options
  * @returns {Promise}
  */
export function boot(options = {}) {
  return resolveOptions(options.config, options).then((options) => {
    var sclang = new SCLang(options);
    return sclang.boot().then(() => {
      return sclang.storeSclangConf().then(() => {
        return sclang;
      });
    });
  });
}

// bwd compat
SCLang.boot = boot;