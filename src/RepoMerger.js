const assert = require('assert');
const http = require('http');
const Config = require('./Config.js');
const Log = require('./Logger.js');
const Util = require('./Util.js');
const PrMerger = require('./PrMerger.js');

const Logger = Log.Logger;

class RepoMerger {

    constructor() {
        this._timer = null;
        this._fireDate = null;
        this._rerun = false;
        this._running = false;
        this._handler = null;
        this._server = null;
        this._lastPrScan = null;
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

    // prNum (if provided) corresponds to a PR, scheduled this 'run'
    async run(handler) {
        if (handler)
            this._handler = handler;

        if (this._running) {
            Logger.info("Already running, planning rerun.");
            this._rerun = true;
            return;
        }
        this._unplan();
        this._running = true;
        let rerunIn = null;
        do {
            try {
                this._rerun = false;
                if (!this._server)
                    await this._createServer();

                this._lastPrScan = await PrMerger.Step(this._lastPrScan);

                rerunIn = this._lastPrScan.delay;
            } catch (e) {
                Log.LogError(e, "RepoMerger.run");
                this._rerun = true;
                this._lastPrScan = null;
                Logger.info("closing HTTP server");
                this._server.close(this._onServerClosed.bind(this));

                const period = 10; // 10 min
                Logger.info("next re-try in " + period + " minutes.");
                await Util.sleep(period * 60 * 1000); // 10 min
            }
        } while (this._rerun);
        if (rerunIn)
            this._plan(rerunIn);
        this._running = false;
    }

    _onServerClosed() {
        Logger.info("HTTP server closed.");
        this._server = null;
    }

    _plan(requestedMs) {
        assert(requestedMs > 0);
        // obey node.js setTimeout() limits
        const maxMs = Math.pow(2, 31) - 1;
        const ms = Math.min(requestedMs, maxMs);

        assert(this._timer === null);
        let date = new Date();
        date.setSeconds(date.getSeconds() + ms/1000);
        this._timer = setTimeout(this.run.bind(this), ms);
        Logger.info("planning rerun in " + this._msToTime(ms));
    }

    _unplan() {
        if (this._timer !== null) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }

    // duration in ms
    _msToTime(duration) {
        let seconds = parseInt((duration/1000)%60);
        let minutes = parseInt((duration/(1000*60))%60);
        let hours = parseInt((duration/(1000*60*60))%24);
        let days = parseInt((duration/(1000*60*60*24)));

        days = (days < 10) ? "0" + days : days;
        hours = (hours < 10) ? "0" + hours : hours;
        minutes = (minutes < 10) ? "0" + minutes : minutes;
        seconds = (seconds < 10) ? "0" + seconds : seconds;

        return days + "d " + hours + "h " + minutes + "m " + seconds + "s";
    }
}

const Merger = new RepoMerger();

module.exports = Merger;

