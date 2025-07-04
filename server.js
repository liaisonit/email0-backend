// server.js
const express = require('express');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
} catch (e) {
  console.error('CRITICAL ERROR: Could not parse FIREBASE_SERVICE_ACCOUNT_KEY. Make sure it is set correctly in your .env file and is a valid JSON object.');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  res.send('eMail0 Backend is running!');
});

async function processEmailQueue() {
  console.log('Checking for new campaigns to process...');
  const appId = process.env.APP_ID;
  if (!appId) {
      console.error("CRITICAL ERROR: APP_ID is not defined in your .env file.");
      return;
  }

  const campaignsRef = db.collectionGroup('campaigns');
  const snapshot = await campaignsRef.where('status', '==', 'Queued').get();

  if (snapshot.empty) {
    console.log('No queued campaigns found.');
    return;
  }

  console.log(`Found ${snapshot.docs.length} campaign(s) to process.`);

  for (const campaignDoc of snapshot.docs) {
    const campaign = campaignDoc.data();
    const campaignId = campaignDoc.id;
    const userId = campaignDoc.ref.parent.parent.id;

    console.log(`Processing campaign ${campaignId} for user ${userId}`);

    try {
      const settingsDoc = await db.collection('artifacts').doc(appId).collection('users').doc(userId).collection('config').doc('smtp').get();
      const templateDoc = await db.collection('artifacts').doc(appId).collection('users').doc(userId).collection('templates').doc(campaign.templateId).get();

      if (!settingsDoc.exists || !templateDoc.exists) {
        console.error(`Missing settings or template for campaign ${campaignId}. Skipping.`);
        await campaignDoc.ref.update({ status: 'Failed', error: 'Missing settings or template.' });
        continue;
      }

      const settings = settingsDoc.data();
      const template = templateDoc.data();

      const transporter = nodemailer.createTransport({
        host: settings.smtp_host,
        port: settings.smtp_port,
        secure: settings.smtp_port === 465,
        auth: {
          user: settings.smtp_user,
          pass: settings.smtp_pass,
        },
      });

      const emailLogsRef = db.collection('artifacts').doc(appId).collection('users').doc(userId).collection('email_logs');
      const emailLogsSnapshot = await emailLogsRef.where('campaignId', '==', campaignId).where('status', '==', 'Queued').get();

      for (const logDoc of emailLogsSnapshot.docs) {
        const emailLog = logDoc.data();
        console.log(`Sending email to ${emailLog.clientEmail}...`);

        try {
          await transporter.sendMail({
            from: `"${settings.from_name}" <${settings.from_email}>`,
            to: emailLog.clientEmail,
            subject: template.subject,
            html: template.htmlBody,
          });

          await logDoc.ref.update({ status: 'Sent', sentAt: new Date() });
          console.log(`Email to ${emailLog.clientEmail} sent successfully.`);

        } catch (emailError) {
          console.error(`Failed to send email to ${emailLog.clientEmail}:`, emailError);
          await logDoc.ref.update({ status: 'Failed', error: emailError.message });
        }
      }

      await campaignDoc.ref.update({ status: 'Sent' });
      console.log(`Campaign ${campaignId} processed successfully.`);

    } catch (error) {
      console.error(`Error processing campaign ${campaignId}:`, error);
      await campaignDoc.ref.update({ status: 'Failed', error: error.message });
    }
  }
}

setInterval(processEmailQueue, 60000);

const listener = app.listen(process.env.PORT || 3000, () => {
  console.log('Your app is listening on port ' + listener.address().port);
  processEmailQueue();
});
