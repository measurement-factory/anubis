const assert = require('assert');
const Config = require('./Config.js');
const Log = require('./Logger.js');
const Logger = Log.Logger;
const GH = require('./GitHubUtil.js');
const Util = require('./Util.js');
const MergeContext = require('./MergeContext.js');
const PullRequest = MergeContext.PullRequest;

// Gets PR list from GitHub and processes some/all PRs from this list.
class PrMerger {

    constructor() {
        this.total = 0;
        this.errors = 0;
        // stores the the number of milliseconds to be re-run
        // for the oldest 'slow burner'
        this.rerunIn = null;
        this._prList = null;
        this._tags = null;
    }

    async _clearedForMerge(prNum) {
        const labels = await GH.getLabels(prNum);
        return labels.find(lbl => lbl.name === Config.clearedForMergeLabel()) !== undefined;
    }

    /// Establishes correct PRs processing order.
    async _preparePRList(stagingPr) {
        // temporary add a field used for sorting below
        for (let pr of this._prList)
            pr.clearedForMerge = await this._clearedForMerge(pr.number);

        // Processing staged PR Y in its natural PR number order X,Y,Z would result
        // in aborting staging for Y and becoming X staged.
        // Processing non-cleared-for-merge PR X in its natural PR number order X,Y
        // would make Y waiting for X until it becomes cleared for merge.
        // 'cleared-for-merge' sorting criteria is applied before 'staged' to avoid
        // getting stuck on a staged PR lacking 'cleared-for-merge' label.
        this._prList.sort((pr1, pr2) => { return (Config.guardedRun() && (pr2.clearedForMerge - pr1.clearedForMerge)) ||
                (stagingPr && ((pr2.number === stagingPr.number) - (pr1.number === stagingPr.number))) ||
                pr1.number - pr2.number;
        });

        // remove the temporary field
        for (let pr of this._prList)
            delete pr.clearedForMerge;

        this._logPRList("PRs selected for processing: ");
    }

    _logPRList(description) {
        let prStr = description;
        if (this._prList.length === 0)
            prStr += "empty list";
        else {
            for (let pr of this._prList)
                prStr += pr.number + " ";
        }
        Logger.info(prStr);
    }

    // Gets PR list from GitHub and processes them one by one.
    // Returns if either all PRs have been processed(merged or skipped), or
    // there is a PR still-in-merge.
    async runStep() {
        Logger.info("runStep running");
        // all repository tags
        this._tags = await GH.getTags();
        this._prList = await GH.getPRList();
        this._logPRList("PRs received from GitHub: ");

        await this._cleanTags();

        const stagingPr = await this._current();
        await this._preparePRList(stagingPr);

        this.total = 0;
        let somePrWasStaged = false;
        while (this._prList.length) {
            try {
                const rawPr = this._prList.shift();
                this.total++;
                let pr = new PullRequest(rawPr, somePrWasStaged);
                const result = await pr.process();
                somePrWasStaged = somePrWasStaged || pr.staged();
                if (result.delayed() && (this.rerunIn === null || this.rerunIn > result.delay()))
                    this.rerunIn = result.delay();
            } catch (e) {
                this.errors++;
                if (this._prList.length)
                    Log.LogError(e, "PrMerger.runStep");
                else
                    throw e;
            }
        }
        return false;
    }

    /// removes PR-unrelated tags from the list and deletes PR tags
    /// from GitHub which do not have corresponding opened PRs
    async _cleanTags() {
        assert(this._tags);

        let filteredTags = [];
        for (let tag of this._tags) {
            let prNum = Util.ParseTag(tag.ref);
            if (prNum === null)
                continue;
            for (let pr of this._prList) {
                if (prNum === pr.number.toString()) {
                    prNum = null;
                    filteredTags.push(tag);
                    break;
                }
            }
            if (prNum !== null) {
                if (!Config.dryRun())
                    await GH.deleteReference(Util.StagingTag(prNum));
            }
        }
        this._tags = filteredTags;
    }

    // returns raw PR having staging commit at the tip of the staging branch (or null)
    // if that PR exists, it is either "staged" or "post-staged"
    async _current() {
        Logger.info("Looking for the current PR...");
        const stagingSha = await GH.getReference(Config.stagingBranchPath());
        // search for a tag, the staging_branch points to,
        // and parse out PR number from the tag name
        const tag = this._tags.find((t) => { return (t.object.sha === stagingSha) && Util.MatchTag(t.ref); });
        if (tag === undefined) {
            Logger.info("No current PR found.");
            return null;
        }
        const prNum = Util.ParseTag(tag.ref);
        Logger.info("PR" + prNum + " is the current");
        const stagingPr = await GH.getPR(prNum, false);
        assert(stagingPr.state === "open");
        return stagingPr;
    }

    logStatistics() {
        Logger.info("Merge step finished. Total PRs processed: " + this.total + ", skipped due to errors: " + this.errors);
    }
} // PrMerger

module.exports = PrMerger;

