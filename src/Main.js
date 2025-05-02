const assert = require('assert');
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

function HandlerWrap(handler) {
    return (ev) => {
        let prIds = null;
        try {
            prIds = handler(ev);
            assert(prIds);
            Logger.info("PrIds discovered by the event handler:", prIds.length);
            if (prIds.length === 0)
                return;
        } catch (err) {
            Logger.error("Event handler error:", err.message);
        }
        Merger.run(prIds);
    };
}

// https://developer.github.com/v3/activity/events/types/#pullrequestreviewevent
WebhookHandler.on('pull_request_review', HandlerWrap((ev) => {
    const pr = ev.payload.pull_request;
    Logger.info("pull_request_review event:", ev.payload.id, pr.number, pr.head.sha, pr.state);
    return Util.PrId.PrNum(pr.number);
}));

// https://developer.github.com/v3/activity/events/types/#pullrequestevent
WebhookHandler.on('pull_request', HandlerWrap((ev) => {
    const pr = ev.payload.pull_request;
    Logger.info("pull_request event:", ev.payload.id, pr.number, pr.head.sha, pr.state);
    return Util.PrId.PrNum(pr.number);
}));

// https://developer.github.com/v3/activity/events/types/#statusevent
WebhookHandler.on('status', HandlerWrap((ev) => {
    const e = ev.payload;
    Logger.info("status event:", e.id, e.sha, e.context, e.state);
    const branches = Array.from(e.branches, b => b.name);
    return Util.PrId.BranchList(branches, e.commit.commit.message);
}));

// https://developer.github.com/v3/activity/events/types/#pushevent
WebhookHandler.on('push', HandlerWrap((ev) => {
    const e = ev.payload;
    Logger.info("push event:", e.ref);

    // e.ref uses refs/heads/<branch_name> format for branches
    // (and refs/tags/<tag_name> format for tags)
    if (e.ref.startsWith('refs/heads/')) {
        const branch = e.ref.replace('refs/heads/', '');
        return Util.PrId.BranchList([branch], e.head_commit ? e.head_commit.message : null);
    } else {
        Logger.info("push event: ignore a non-branch", e.ref);
        return [];
    }
}));

// prUrl format, e.g., https://api.github.com/repos/github/hello-world/pulls/1
// whether the PR belongs to Squid Project
function isPrValid(prUrl) {
    const basePath = Config.baseUrl() + '/repos/';
    assert(prUrl.startsWith(basePath));
    const arr = prUrl.substring(basePath.length).split('/');
    assert(arr.length === 4);
    return arr[0] === Config.owner();
}

function handleCheckEvent(name, e) {
    Logger.info(`${name} event:`, e.head_sha);

    if (e.pull_requests.length) {
        let numbers = [];
        for (let pr of e.pull_requests) {
            if (isPrValid(pr.url)) {
                numbers.push(pr.number);
            } else {
                Logger.info(`${name} event: ignore a non Squid Project PR with ${pr.url} for `, e.head_sha);
            }
        }
        if (numbers.length) {
            return Util.PrId.PrNumList(numbers);
        }
    }

    if (e.head_branch === Config.stagingBranch()) {
        return Util.PrId.Sha(e.head_sha);
    }
    // workflow runs for other non-PR branches (e.g., master) are not associated with PRs
    Logger.info(`${name} event: no PR for`, e.head_sha);
    return [];
}

// https://docs.github.com/ru/webhooks/webhook-events-and-payloads#workflow_run
WebhookHandler.on('workflow_run', HandlerWrap((ev) => {
    return handleCheckEvent("workflow_run", ev.payload.workflow_run);
}));

// https://docs.github.com/en/webhooks/webhook-events-and-payloads#check_run
WebhookHandler.on('check_run', HandlerWrap((ev) => {
    return handleCheckEvent("check_run", ev.payload.check_run.check_suite);
}));

WebhookHandler.on('ping', (ev) => {
    const e = ev.payload;
    Logger.info("ping event, hook_id:", e.hook_id);
});

Merger.run(null, WebhookHandler);

