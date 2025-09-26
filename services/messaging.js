// services/messaging.js
// Builds customer-facing links for manual messaging (WhatsApp/SMS). Pluggable providers later.

require('dotenv').config();

const APP_URL = process.env.APP_URL || 'http://localhost:5008';
const LIVE_BASE_URL = process.env.LIVE_BASE_URL || APP_URL;
const MSG_PROVIDER = (process.env.MSG_PROVIDER || 'manual').toLowerCase();

/** Build the public status link for a booking */
function buildStatusLink({ org_id, booking_id, token, phone }) {
  const url = new URL('/public/status.html', LIVE_BASE_URL);
  if (org_id) url.searchParams.set('org_id', org_id);
  if (booking_id) url.searchParams.set('booking_id', booking_id);
  else if (token) {
    url.searchParams.set('token', token);
    if (phone) url.searchParams.set('phone', phone);
  }
  return url.toString();
}

/** Build WhatsApp deep link (manual) */
function buildWhatsAppLink({ phone, statusLink, orgName }) {
  const text = `Hi! Your booking is confirmed for ${orgName || 'our center'}.\nLive queue status: ${statusLink}`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

/** Build SMS deep link (manual; may not auto-open on some devices) */
function buildSmsLink({ phone, statusLink, orgName }) {
  const body = `Your booking with ${orgName || 'our center'} is confirmed. Live status: ${statusLink}`;
  return `sms:${phone}?&body=${encodeURIComponent(body)}`;
}

/** Main entry: manual provider returns links; other providers would send immediately */
async function sendBookingConfirmation({ provider = MSG_PROVIDER, toPhone, orgName, statusLink }) {
  if (provider === 'manual') {
    return {
      mode: 'manual',
      whatsapp: buildWhatsAppLink({ phone: toPhone, statusLink, orgName }),
      sms: buildSmsLink({ phone: toPhone, statusLink, orgName })
    };
  }
  // TODO: twilio/cloudapi/d360 providers here
  return { mode: provider, result: 'not-implemented' };
}

module.exports = {
  buildStatusLink,
  sendBookingConfirmation
};
