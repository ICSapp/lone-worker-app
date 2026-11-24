// Sending alerts to people.
//
// - Dashboard users (office / managers / on-call with a login) get a
//   notification on every phone or tablet where they tapped "Turn on alerts".
// - Office & on-call contacts without a login would get a text message. Text
//   messages are a STUB for now: they are recorded (History -> Messages) but
//   not sent. To send real texts, plug an SMS provider (e.g. Twilio) in below
//   using keys stored as environment variables, never in the code.
'use strict';

function createNotifier(store, { log = console.log, push = null } = {}) {
  function record(entry) {
    const rec = { id: store.id(), at: new Date().toISOString(), ...entry };
    store.db.notifications.unshift(rec);
    store.db.notifications = store.db.notifications.slice(0, 500);
    store.save();
    return rec;
  }

  return function notify({ to, subject, body, alertId = null, urgent = false }) {
    const isUser = to && to.id && store.db.users.some((u) => u.id === to.id);
    if (isUser) {
      const devices = push ? (to.pushSubs || []).length : 0;
      if (!devices) {
        return record({ channel: 'dashboard', to: to.name, subject, body, alertId, delivered: false, provider: 'none', status: 'Alerts not turned on on any device' });
      }
      const rec = record({ channel: 'push', to: to.name, subject, body, alertId, delivered: null, provider: 'web-push', status: 'Sending' });
      push.sendToUser(to, { title: subject, body, alertId, urgent, url: '/manager' })
        .then((n) => {
          rec.delivered = n > 0;
          rec.status = n > 0 ? `Sent to ${n} device${n > 1 ? 's' : ''}` : 'Could not reach any device';
          store.save();
        })
        .catch((err) => log('[notify] push error', err));
      return rec;
    }
    const label = to && to.name ? `${to.name} <${to.phone || to.email || 'no contact details'}>` : String(to);
    log(`[notify:stub] sms to ${label}: ${subject} - ${body}`);
    return record({ channel: 'sms', to: label, subject, body, alertId, delivered: false, provider: 'stub', status: 'Not sent (texts not set up yet)' });
  };
}

module.exports = { createNotifier };
