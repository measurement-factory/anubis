const assert = require('assert');
const http = require('http');
const createHandler = require('github-webhook-handler');
const Config = require('../config/Config.js');
const Log = require('../src/Logger.js');
const GH = require('../src/GitHubUtil.js');

const Logger = Log.Logger;

const WebhookHandler = createHandler({ path: Config.githubWebhookPath(), secret: Config.githubWebhookSecret() });

// Emulates a CI.
// Listens for GitHub events coming on a listening port (GitHub webhook) and extracts SHA.
// For the SHA, creates/updates GitHub statuses, according to the configuration.
class CiEmulator {

    constructor() {
        this._server = null;
        this._sha = null;
        this._handler = null;
    }

    _createServer() {
        assert(!this._server);

        this._server = http.createServer((req, res) => {
            assert(this._handler);
            this._handler(req, res, () => {
                res.statusCode = 404;
                res.end('no such location');
            });
        });

        this._server.on('error', (e) => {
                Logger.error("HTTP server error: " + e.code);
            }
        );

        Logger.info("Location: " + Config.githubWebhookPath());
        return new Promise((resolve) => {
            const params = {port: Config.port()};
            if (Config.host())
                params.host = Config.host();
            this._server.listen(params, () => {
                let hostStr = Config.host() ? Config.host() : "unspecified";
                Log.Logger.info("HTTP server started and listening on " + hostStr + ":" + Config.port());
                resolve(true);
            });
        });
    }

    async start(handler) {
        assert(handler);
        assert(!this.server);
        this._handler = handler;
        await this._createServer();
    }

    async run(sha, scope) {
        this.sha = sha;
        const statuses = Config.prStatuses(scope);
        assert(statuses);
        for (const st of statuses) {
            const combinedStatus = await GH.getStatuses(sha);
            const existingStatus = combinedStatus.statuses ?
                combinedStatus.statuses.find(el => el.context.trim() === st.context) : null;

            if (existingStatus &&
                    (existingStatus.state === st.state && existingStatus.description === st.description)) {
                Logger.info("skipping existing status: " + st.context + " " + st.state);
                continue;
            }

            Logger.info("applying status: " + st.context + " " + st.state);
            await GH.createStatus(sha, st.state, Config.statusUrl(), st.description, st.context);
        }
    }
}

const Emulator = new CiEmulator();

// events

WebhookHandler.on('error', (err) => {
   Logger.error('Error:', err.message);
});

// https://developer.github.com/v3/activity/events/types/#pullrequestreviewevent
WebhookHandler.on('pull_request_review', (ev) => {
    const pr = ev.payload.pull_request;
    Logger.info("pull_request_review event:", pr.number, pr.head.sha, pr.state, pr.merge_commit_sha);
    Emulator.run(pr.head.sha, "pr_status");
});

// https://developer.github.com/v3/activity/events/types/#pullrequestevent
WebhookHandler.on('pull_request', (ev) => {
    const pr = ev.payload.pull_request;
    Logger.info("pull_request event:", pr.number, pr.head.sha, pr.state, pr.merge_commit_sha);
    Emulator.run(pr.head.sha, "pr_status");
});

// https://developer.github.com/v3/activity/events/types/#pushevent
WebhookHandler.on('push', (ev) => {
    const e = ev.payload;
    if (!e.head_commit) {
        Logger.info("Push event ", e.ref, ",no head_commit, skipping");
        return;
    }

    Logger.info("push event:", e.ref, e.head_commit.id);
    if (e.ref.endsWith(Config.stagingBranchPath()))
        Emulator.run(e.head_commit.id, "staged_status");
    else
        Logger.info("skipping", e.ref);
})

Emulator.start(WebhookHandler);

