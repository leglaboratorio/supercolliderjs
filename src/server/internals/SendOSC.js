
import {EventEmitter} from 'events';
import {Observable} from 'rx';
import {makeBundle, makeMessage, deltaTimeTag} from '../osc/utils';

/**
 * Owned by the Server, this is an object that you call .msg or .bundle on
 * to send OSC.
 *
 * The Server subscribes to this and does the actual sending.
 * You may also subscribe to this for debugging, logging or entertainment purposes.
 */
export default class SendOSC extends EventEmitter {

  msg(message) {
    this.emit('msg', makeMessage(message));
  }

  /**
  * bundle
  *
  * Note that in SuperCollider language a number is interpreted
  * as relative seconds from 'now'; here is is interpreted as a
  * unix timestamp. See deltaTimeTag
  *
  * @param {null|Number|Array|Date} time -
  *         null: now, immediately
  *         Number: if less than 10000 then it is interpreted
  *          as number of seconds from now.
  *          It it is larger then it is interpreted as a unix timestamp in seconds
  *         Array: [secondsSince1900Jan1, fractionalSeconds]
  *         Date
  * @param {Array} packets - osc messages as [address, arg1, ...argN]
  *                        or bundles as Objects: .timeTag .packets
  */
  bundle(time, packets) {
    if ((typeof time === 'number') && (time < 10000)) {
      time = deltaTimeTag(time);
    }
    this.emit('bundle', makeBundle(time, packets));
  }

  /**
   * deltaTimeTag(secondsFromNow, [now])
   *
   * Make NTP timetag array relative to the current time.
   *
   * Usage:
   * server.send.bundle(server.send.deltaTimetag(1.0), [ ... msgs ]);
   *
   * @param {Number} secondsFromNow
   * @param {Date} now - optional, default new Date
   */
  deltaTimeTag(delta, now) {
    return deltaTimeTag(delta, now);
  }

  /**
   * Subscribe to monitor OSC messages and bundles sent.
   *
   * Events are: {type: msg|bundle: payload: Array}
   *
   * @returns {Rx.Disposable} - `thing.dispose();` to unsubscribe
   */
  subscribe(onNext, onError, onComplete) {
    var msgs = Observable.fromEvent(this, 'msg', (msg) => {
      return {type: 'msg', payload: msg};
    });
    var bundles = Observable.fromEvent(this, 'bundle', (bundle) => {
      return {
        type: 'bundle',
        payload: bundle
      };
    });
    var combo = msgs.merge(bundles);
    return combo.subscribe(onNext, onError, onComplete);
  }
}