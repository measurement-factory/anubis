const fs = require('fs');
const assert = require('assert');

class ConfigOptions {
    constructor(fname) {
        const conf = JSON.parse(fs.readFileSync(fname), (key, value) => {
                    if (value === "process.stdout")
                         return process.stdout;
                    if (value === "process.stderr")
                         return process.stderr;
                    return value;
                });

        this._githubUserLogin = conf.github_login;
        this._githubToken = conf.github_token;
        this._githubWebhookPath = conf.github_webhook_path;
        this._githubWebhookSecret = conf.github_webhook_secret;
        this._repo = conf.repo;
        this._host = conf.host;
        this._port = conf.port;
        this._owner = conf.owner;
        this._stagingBranch = conf.staging_branch;
        this._loggerParams = conf.logger_params;
        this._statusParams = conf.status_params;

        this._githubUserName = null;

        const allOptions = Object.values(this);
        for (let v of allOptions) {
            assert(v !== undefined );
        }
    }

    githubUserLogin() { return this._githubUserLogin; }
    githubUserName(name) {
        if (name !== undefined)
            this._githubUserName = name;
        return this._githubUserName;
    }
    githubToken() { return this._githubToken; }
    githubWebhookPath() { return this._githubWebhookPath; }
    githubWebhookSecret() { return this._githubWebhookSecret; }
    repo() { return this._repo; }
    host() { return this._host; }
    port() { return this._port; }
    owner() { return this._owner; }
    stagingBranchPath() { return "heads/" + this._stagingBranch; }
    loggerParams() { return this._loggerParams; }
    statusParams() { return this._statusParams; }
    statusUrl() { return "http://example.com"; }
    dryRun() { return false; }

    prStatuses(scope) {
        for (let p of this._statusParams) {
            if (p.scope === scope)
                return p.statuses;
        }
        return null;
    }
}

const configFile = process.argv.length > 2 ? process.argv[2] : './config.json';
const Config = new ConfigOptions(configFile);

module.exports = Config;
