// Sending alerts to people.
//
// Right now this is a STUB: messages are recorded (and shown on the manager
// dashboard under "Messages sent") but no real SMS, email or push is sent.
// To go live, plug a provider in here, e.g. Twilio (SMS/voice calls),
// SendGrid/Postmark (email) or web push. Each needs its own account and keys,
// which should be set as environment variables, never written in the code.
'use strict';

function createNotifier(store, { log = console.log } = {}) {
  return function notify({ to, channel = 'sms', subject, body, alertId = null }) {
    const record = {
      id: store.id(),
      at: new Date().toISOString(),
      channel,
      to: to.name ? `${to.name} <${to.phone || to.email || 'no contact details'}>` : String(to),
      subject,
      body,
      alertId,
      delivered: false,
      provider: 'stub',
    };
    store.db.notifications.unshift(record);
    store.db.notifications = store.db.notifications.slice(0, 500);
    store.save();
    log(`[notify:stub] ${channel} to ${record.to}: ${subject} - ${body}`);
    return record;
  };
}

module.exports = { createNotifier };
