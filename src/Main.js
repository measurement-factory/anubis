const createHandler = require('github-webhook-handler');
const Config = require('./Config.js');
const Log = require('./Logger.js');
const Merger = require('./RepoMerger.js');
const Util = require('./Util.js');

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

function HandlerWrap(ev, handler) {
    try {
        handler(ev);
    } catch (err) {
        Logger.error("Error in", err.message);
        Merger.run(null);
    }
}

// https://developer.github.com/v3/activity/events/types/#pullrequestreviewevent
WebhookHandler.on('pull_request_review', (anEv) => {
    HandlerWrap(anEv, (ev) => {
        const pr = ev.payload.pull_request;
        Logger.info("pull_request_review event:", ev.payload.id, pr.number, pr.head.sha, pr.state);
        Merger.run(Util.PrId.PrNum(pr.number));
    });
});

// https://developer.github.com/v3/activity/events/types/#pullrequestevent
WebhookHandler.on('pull_request', (anEv) => {
    HandlerWrap(anEv, (ev) => {
        const pr = ev.payload.pull_request;
        Logger.info("pull_request event:", ev.payload.id, pr.number, pr.head.sha, pr.state);
        Merger.run(Util.PrId.PrNum(pr.number));
    });
});

// https://developer.github.com/v3/activity/events/types/#statusevent
WebhookHandler.on('status', (anEv) => {
    HandlerWrap(anEv, (ev) => {
    const e = ev.payload;
    Logger.info("status event:", e.id, e.sha, e.context, e.state);
    const branches = Array.from(e.branches, b => b.name);
    if (branches.includes(Config.stagingBranch())) {
        const message = e.commit.commit.message;
        const prNum = Util.ParsePrNumber(message);
        if (prNum === null) {
            throw new Error(`status event: Could not extract PR number from the message: ${message}`);
        } else {
            Merger.run(Util.PrId.PrNum(prNum));
        }
    } else {
        Merger.run(Util.PrId.BranchList(branches));
    }
    });
});

// https://developer.github.com/v3/activity/events/types/#pushevent
WebhookHandler.on('push', (anEv) => {
    HandlerWrap(anEv, (ev) => {
    const e = ev.payload;
    Logger.info("push event:", e.ref);

    // e.ref as refs/heads/branch_name
    const parts = e.ref.split('/');
    const branch = parts[parts.length-1];

    if (branch !== Config.stagingBranch()) {
        Merger.run(Util.PrId.Branch(branch));
        return;
    }

    if (e.head_commit) {
        const prNum = Util.ParsePrNumber(e.head_commit.message);
        if (prNum === null) {
            throw new Error(`push event: Could not extract PR number from the message: ${e.head_commit.message}`);
        } else {
            Merger.run(Util.PrId.PrNum(prNum));
        }
        return;
    }
    throw new Error("push event: e.head_commit is null");
    });
});

// https://docs.github.com/ru/webhooks/webhook-events-and-payloads#workflow_run
WebhookHandler.on('workflow_run', (anEv) => {
    HandlerWrap(anEv, (ev) => {
    const e = ev.payload.workflow_run;
    Logger.info("workflow_run event:", e.head_sha);
    // e.pull_requests is empty for the staged commit
    if (e.head_branch === Config.stagingBranch()) {
        Merger.run(Util.PrId.Sha(e.head_sha));
        return;
    }
    if (!e.pull_requests.length) {
        // e.pull_requests is empty, e.g., for master commits
        Logger.info("workflow_run event: no PR for ", e.head_sha);
        return;
    }
    const list = Array.from(e.pull_requests, v => v.number);
    Merger.run(Util.PrId.PrNumList(list));
    });
});

// https://docs.github.com/en/webhooks/webhook-events-and-payloads#check_run
WebhookHandler.on('check_run', (anEv) => {
    HandlerWrap(anEv, (ev) => {
    const e = ev.payload.check_run;
    Logger.info("check_run event:", e.head_sha);
    // e.check_suite.pull_requests is empty for the staged commit
    if (e.check_suite.head_branch === Config.stagingBranch()) {
        Merger.run(Util.PrId.Sha(e.head_sha));
        return;
    }
    if (!e.check_suite.pull_requests.length) {
        // e.check_suite.pull_requests is empty, e.g., for master commits
        Logger.info("check_run event: no PR for ", e.head_sha);
        return;
    }
    const list = Array.from(e.check_suite.pull_requests, v => v.number);
    Merger.run(Util.PrId.PrNumList(list));
    });
});

WebhookHandler.on('ping', (ev) => {
    const e = ev.payload;
    Logger.info("ping event, hook_id:", e.hook_id);
});

Merger.run(null, WebhookHandler);

