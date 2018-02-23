const fs = require('fs');
const timestring = require('timestring');
const assert = require('assert');

class ConfigOptions {
    constructor(fname) {
        const conf = JSON.parse(fs.readFileSync(fname));
        this._githubUserLogin = conf.github_login;
        this._githubToken = conf.github_token;
        this._githubWebhookPath = conf.github_webhook_path;
        this._githubWebhookSecret = conf.github_webhook_secret;
        this._repo = conf.repo;
        this._host = conf.host;
        this._port = conf.port;
        this._owner = conf.owner;
        this._stagingBranch = conf.staging_branch;
        this._dryRun = conf.dry_run;
        this._stagedRun = conf.staged_run;
        this._necessaryApprovals = conf.necessary_approvals;
        this._sufficientApprovals = conf.sufficient_approvals;
        assert(this._sufficientApprovals > 1);
        this._votingDelayMax = timestring(conf.voting_delay_max, 'ms');
        this._votingDelayMin = timestring(conf.voting_delay_min, 'ms');
        this._stagingChecks = conf.staging_checks;
        this._loggerParams = conf.logger_params;

        // unused
        this._githubUserNoreplyEmail = null;

        this._githubUserEmail = null;
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
    // unused
    // 'noreply' email (see https://help.github.com/articles/about-commit-email-addresses/)
    githubUserNoreplyEmail(id) {
        if (id !== undefined)
            this._githubUserNoreplyEmail = id + "+" + this.githubUserLogin() + "@users.noreply.github.com";
        return this._githubUserNoreplyEmail;
    }
    // primary bot user email
    githubUserEmail(email) {
        if (email !== undefined)
            this._githubUserEmail = email;
        return this._githubUserEmail;
    }
    githubToken() { return this._githubToken; }
    githubWebhookPath() { return this._githubWebhookPath; }
    githubWebhookSecret() { return this._githubWebhookSecret; }
    repo() { return this._repo; }
    host() { return this._host; }
    port() { return this._port; }
    owner() { return this._owner; }
    stagingBranchPath() { return "heads/" + this._stagingBranch; }
    dryRun() { return this._dryRun; }
    stagedRun() { return this._stagedRun; }
    necessaryApprovals() { return this._necessaryApprovals; }
    sufficientApprovals() { return this._sufficientApprovals; }
    votingDelayMax() { return this._votingDelayMax; }
    votingDelayMin() { return this._votingDelayMin; }
    stagingChecks() { return this._stagingChecks; }
    loggerParams() { return this._loggerParams; }

    // fast-forward merge failed
    failedOtherLabel() { return "M-failed-other"; }
    // some of required staging checks failed
    failedStagingChecksLabel() { return "M-failed-staging-checks"; }
    // fast-forward merge succeeded
    mergedLabel() { return "M-merged"; }
    // merge started (tag and staging branch successfully adjusted)
    waitingStagingChecksLabel() { return "M-waiting-staging-checks"; }
    // passed staging checks (in staged-run mode)
    passedStagingChecksLabel() { return "M-passed-staging-checks"; }
    // future commit message violates requirements
    failedDescriptionLabel() { return "M-failed-description"; }
}

const configFile = process.argv.length > 2 ? process.argv[2] : './config.json';
const Config = new ConfigOptions(configFile);

module.exports = Config;
