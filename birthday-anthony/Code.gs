// Google Apps Script: receives Anthony's message from the birthday page
// and emails it to Yezsa. Deploy as a web app (see README.md, step 1).

const TO = 'princessrico2004@gmail.com';   // where messages are delivered
const MAX_LEN = 2000;                      // longest message accepted
const DAILY_LIMIT = 20;                    // messages per day, to stop spam

function doPost(e) {
  try {
    const raw = e && e.postData ? e.postData.contents : '{}';
    const data = JSON.parse(raw || '{}');
    const msg = String(data.message || '').trim().slice(0, MAX_LEN);
    if (!msg) return ContentService.createTextOutput('empty');

    const props = PropertiesService.getScriptProperties();
    const key = 'count-' + new Date().toISOString().slice(0, 10);
    const count = Number(props.getProperty(key) || 0);
    if (count >= DAILY_LIMIT) return ContentService.createTextOutput('limit');
    props.setProperty(key, String(count + 1));

    MailApp.sendEmail({
      to: TO,
      subject: 'a birthday message from Anthony',
      body: msg,
      name: 'Birthday page'
    });
    return ContentService.createTextOutput('ok');
  } catch (err) {
    return ContentService.createTextOutput('error');
  }
}
