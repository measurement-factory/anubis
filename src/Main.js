const createHandler = require('github-webhook-handler');
const Config = require('./Config.js');
const Log = require('./Logger.js');
const Merger = require('./RepoMerger.js');

const Logger = Log.Logger;

const WebhookHandler = createHandler({ path: Config.githubWebhookPath(), secret: Config.githubWebhookSecret() });

process.on('unhandledRejection', error => {
    Logger.error("unhandledRejection", error.message, error.stack);
    throw error;
});

// events

WebhookHandler.on('error', (err) => {
   Logger.error('Error:', err.message);
});

// https://developer.github.com/v3/activity/events/types/#pullrequestreviewevent
WebhookHandler.on('pull_request_review', (ev) => {
    const pr = ev.payload.pull_request;
    Logger.info("pull_request_review event:", ev.payload.id, pr.number, pr.head.sha, pr.state);
    Merger.run(null, "pull_request_review", pr);
});

// https://developer.github.com/v3/activity/events/types/#pullrequestevent
WebhookHandler.on('pull_request', (ev) => {
    const pr = ev.payload.pull_request;
    Logger.info("pull_request event:", ev.payload.id, pr.number, pr.head.sha, pr.state);
    Merger.run(null, "pull_request", pr);
});

// https://developer.github.com/v3/activity/events/types/#statusevent
WebhookHandler.on('status', (ev) => {
    const e = ev.payload;
    Logger.info("status event:", e.id, e.sha, e.context, e.state);
    Merger.run(null, "status", e);
});

// https://developer.github.com/v3/activity/events/types/#pushevent
WebhookHandler.on('push', (ev) => {
    const e = ev.payload;
    Logger.info("push event:", e.ref);
    Merger.run(null, "push", e);
});

// https://docs.github.com/ru/webhooks/webhook-events-and-payloads#workflow_run
WebhookHandler.on('workflow_run', (ev) => {
    const e = ev.payload.workflow_run;
    Logger.info("workflow_run event:", e.head_sha);
    Merger.run(null, "workflow_run", e);
});

// https://docs.github.com/en/webhooks/webhook-events-and-payloads#check_run
WebhookHandler.on('check_run', (ev) => {
    const e = ev.payload.check_run;
    Logger.info("check_run event:", e.head_sha);
    Merger.run(null, "check_run", e);
});

// https://docs.github.com/ru/webhooks/webhook-events-and-payloads#workflow_run
WebhookHandler.on('workflow_run', (ev) => {
    const e = ev.payload.workflow_run;
    Logger.info("workflow_run event:", e.head_sha);
    Merger.run();
});

// https://docs.github.com/en/webhooks/webhook-events-and-payloads#check_run
WebhookHandler.on('check_run', (ev) => {
    const e = ev.payload.check_run;
    Logger.info("check_run event:", e.head_sha);
    Merger.run();
});

WebhookHandler.on('ping', (ev) => {
    const e = ev.payload;
    Logger.info("ping event, hook_id:", e.hook_id);
});

Merger.run(WebhookHandler);

