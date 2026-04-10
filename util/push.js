import webpush from "web-push";
import { trackExternalCall } from "../middleware/metrics.js";
import logger from "./logger.js";

const pushLogger = logger.child({ component: "push" });

if (
  process.env.MAIL_TO &&
  process.env.VAPID_PUBLIC_KEY &&
  process.env.VAPID_PRIVATE_KEY
) {
  webpush.setVapidDetails(
    `mailto:${process.env.MAIL_TO}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
} else {
  pushLogger.warn("Web push is disabled because VAPID configuration is incomplete", {
    hasMailTo: Boolean(process.env.MAIL_TO),
    hasPublicKey: Boolean(process.env.VAPID_PUBLIC_KEY),
    hasPrivateKey: Boolean(process.env.VAPID_PRIVATE_KEY),
  });
}

async function sendPush(subscription, payload) {
  if (!subscription) {
    pushLogger.warn("Push notification skipped because subscription is missing");
    return false;
  }

  try {
    await trackExternalCall("web_push", "send_notification", () =>
      webpush.sendNotification(subscription, JSON.stringify(payload)),
    );
    pushLogger.debug("Push notification queued", {
      endpoint: subscription.endpoint,
      title: payload?.title,
    });
    return true;
  } catch (error) {
    pushLogger.error("Push notification failed", {
      error,
      endpoint: subscription.endpoint,
      title: payload?.title,
    });
    return false;
  }
}

export default sendPush;
