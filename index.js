const Rss = require('rss-parser');
const ptt = require('parse-torrent-title');
const fs = require('fs-extra');
const path = require('path');

const ShowStatistic = require('./Entities/ShowStatistics');
const Show = require('./Entities/Show');
const { extractRootDomain } = require('./helpers');

const rss = new Rss();
const emitter = global.emitter;
module.exports = class TorrentRSS {
  constructor() {
    this.construct(__dirname);
    /** @type {String[]} */
    this.downloadList = [];
    /** @type {Show[]} */
    this.removedShows = [];
    /** @type {ShowStatistic[]} */
    this.statistics = [];
  }

  setup() {
    this.logDebug('Setting up rssfeed plugin');
    this.settings.shows = this.settings.shows.map((s) => this.getShow(s));

    this.loadRemovedShows();
    this.loadStatistics();

    this.logInfo(
      `Started Torrent RSS feed timer (${this.settings.updateInterval}m)`
    );

    if (this.settings.shows && this.settings.shows.length) {
      /** @type {Show[]} */
      const shows = this.settings.shows.map((show) => this.getShow(show));
      this.settings.shows = shows;
      this.saveSettings(this.settings);
    }

    this.checkFeeds();
  }

  subscriptions() {
    this.subscribe('rssfeed.add-show', this.actOnAddedShow);
    this.subscribe('qbittorrent.download-complete', this.actOnDownloadComplete);
  }

  routes() {
    this.route('get', 'shows', this.getShows);
    this.route('get', 'removed-shows', this.getRemovedShows);
    this.route('post', 'shows', this.postShows);
    this.route('delete', 'shows', this.deleteShows);
    this.route('delete', 'removed-shows', this.deleteRemovedShows);
  }

  /********* Event Functions *********/

  actOnAddedShow = (show, source) => {
    this.addShow(show, source);
    return Promise.resolve(this.settings.shows);
  };

  actOnDownloadComplete = async (torrent) => {
    const showInfo = ptt.parse(torrent.name);
    if (!showInfo) {
      this.logDiag('Could not parse torrent info, aborting.');
      return;
    }

    const show = this.settings.shows.find(
      (s) => this.cleanName(s.name) === this.cleanName(showInfo.title)
    );

    if (!show) {
      this.logDiag('Downloaded torrent is not a show, aborting.');
      return;
    }

    if (show.copyTo.length) {
      const orgPath = path.join(torrent.save_path, torrent.name);
      const newPath = path.join(show.copyTo, torrent.name);

      try {
        this.logInfo(`Copying from ${torrent.save_path} to ${show.copyTo}`);
        await fs.ensureDir(show.copyTo);
        await fs.copyFile(orgPath, newPath);
        this.logInfo(`Finished copying ${orgPath} to ${newPath}`);
      } catch (e) {
        this.logError(
          `Error occurred while trying to copy ${orgPath} to ${newPath}`
        );
      }
    }
  };

  /********* Route Functions *********/

  getShows = (req, res) => {
    return res.status(200).send(this.getShowsWithStats(this.settings.shows));
  };

  getRemovedShows = (req, res) => {
    return res.status(200).send(this.getShowsWithStats(this.removedShows));
  };

  postShows = (req, res) => {
    const show = req.body.show;
    if (!show) {
      return res.status(400).send();
    }
    if (this.settings.shows.includes(show)) {
      return res.status(409).send();
    }
    if (this.removedShows.includes(show)) {
      return res.status(412).send();
    }
    this.addShow(show);
    return res.status(200).send(new Show({ name: show }));
  };

  deleteShows = (req, res) => {
    const show = req.query.show;
    if (!show || this.settings.shows.map((s) => s.name).indexOf(show) === -1) {
      return res.status(412).send();
    }
    this.removeShow(show);
    return res.status(200).send(this.settings.shows);
  };

  deleteRemovedShows = (req, res) => {
    const show = req.query.show;
    if (!show || !this.removedShows.map((r) => r.name).includes(show)) {
      return res.status(412).send();
    }
    this.restoreShow(show);
    return res.status(200).send(this.settings.shows);
  };

  /********* Plugin Functions *********/

  file(filename) {
    return `rssfeed_${filename}`;
  }

  feedTimer() {
    setTimeout(() => {
      this.checkFeeds();
    }, this.settings.updateInterval * 1000 * 60);
  }

  checkFeeds() {
    const settings = this.settings;
    /** @type {Show[]} */
    const showsToDownload = settings.shows || [];
    const feeds = settings.feeds;

    feeds.forEach(async (feedUrl) => {
      const feedDomain = extractRootDomain(feedUrl);
      let feed = await rss.parseURL(feedUrl);

      // Add info to entries
      feed = feed.items
        .reverse()
        .map((entry) => ({
          ...entry,
          release: entry.title.replace(/\s/g, '.'),
          ...ptt.parse(entry.title),
        }))
        .map((entry) => ({
          ...entry,
          fileName: `${entry.release}.torrent`,
          title: this.cleanName(entry.title),
          savePath: this.getSavePath(entry),
        }));

      // Remove files already downloaded
      feed = feed.filter(
        (entry) => !this.downloadList.includes(entry.fileName)
      );

      // Remove entries not in the download list
      feed = feed.filter((entry) =>
        showsToDownload.map((s) => s.name).includes(entry.title)
      );

      // Remove entries not associated to this feed via tracker
      feed = feed.filter(
        () =>
          showsToDownload.map((s) => s.tracker).includes(feedDomain) ||
          showsToDownload.map((s) => s.tracker).includes('*')
      );

      // Remove incorrect resolutions
      feed = feed.filter((entry) => entry.resolution === settings.resolution);

      // Remove incorrect sources
      feed = feed.filter(
        (entry) =>
          entry.source.toLowerCase() === settings.source.toLowerCase() ||
          settings.source === ''
      );

      // Remove foreign if not wanted
      if (settings.skipForeign === true) {
        feed = feed.filter((entry) =>
          entry.categories ? entry.categories.indexOf('Foreign') === -1 : true
        );
      }

      // Remove packs if not wanted
      if (settings.skipPacks === true) {
        feed = feed.filter((entry) => !!entry.episode);
      }

      // Fix save path (don't end filenames with .)
      if (feed.savePath) {
        while (feed.savePath.match(/\.$/)) {
          feed.savePath.substr(0, feed.savePath.length - 1);
        }
      }

      // Check local files and remove duplicates if not proper or repack
      feed = feed.filter((entry) => {
        fs.ensureDirSync(entry.savePath);
        let files = fs
          .readdirSync(entry.savePath)
          .map((file) => ({
            file: file.toLowerCase(),
            ...ptt.parse(file),
            time: fs
              .statSync(path.resolve(entry.savePath, file))
              .mtime.getTime(),
          }))
          .filter(
            (file) => this.cleanName(file.title) === this.cleanName(entry.title)
          )
          .sort((a, b) => b.time - a.time);

        let keep = true;

        for (let i = 0, n = files.length; i < n; i++) {
          const file = files[i];

          if (keep === false) {
            break;
          }

          if (file.season > entry.season) {
            keep = false;
          }

          if (file.season === entry.season && file.episode > entry.episode) {
            keep = false;
          }

          const episodeDownloaded =
            file.episode === entry.episode && file.season === entry.season;

          if (episodeDownloaded === true) {
            keep = false;

            if (
              settings.downloadProperAndRepack === false ||
              entry.source !== file.source
            ) {
              break;
            }

            // Download if proper
            if (entry.proper === true && file.proper === undefined) {
              keep = true;
            }

            // Download if repack
            if (entry.repack === true && file.repack === undefined) {
              keep = true;
            }

            // Download if proper and repack
            if (
              entry.repack === true &&
              entry.proper === true &&
              (file.repack === undefined || file.proper === undefined)
            ) {
              keep = true;
            }
          }
        }
        return keep;
      });

      // Remove remaining duplicates
      for (let i = 0, n = feed.length; i < n; i++) {
        let y = 1;
        const entry = feed[i];
        const nextEntry = feed[i + y];
        do {
          if (
            nextEntry &&
            entry.title === nextEntry.title &&
            entry.season === nextEntry.season &&
            entry.episode === nextEntry.episode
          ) {
            feed.splice(i + y, 1);
          }
          y++;
        } while (
          feed.filter(
            (e) =>
              e &&
              entry &&
              entry.title === e.title &&
              entry.season === e.season &&
              entry.episode === e.episode
          ).length > 1
        );
      }

      // Download remaining torrents
      feed.forEach((entry) => {
        emitter.emit(
          'file.download',
          entry.link,
          path.resolve(entry.savePath, entry.fileName)
        );

        this.updateStatsForShow(entry.title, {
          date: new Date(),
          tracker: extractRootDomain(feedUrl),
        });
      });

      this.downloadList.unshift(...feed.map((e) => e.fileName));
      this.downloadList.length = 20;
    });

    this.feedTimer();
  }

  async loadRemovedShows() {
    let removedShows = this.readFile(this.file('removedshows.json')) || [];
    removedShows = removedShows.map((show) => this.getShow(show));
    this.removedShows = removedShows;
  }

  async loadStatistics() {
    this.statistics = this.readFile(this.file('statistics.json')) || [];

    if (this.statistics.length) {
      this.statistics = this.statistics.map((show) => new ShowStatistic(show));
    }
  }

  updateStatsForShow(show, downloadInfo) {
    const idx = this.statistics.findIndex((stat) => stat.name === show.name);
    const match = idx === -1 ? false : true;

    /** @type {ShowStatistic} */
    let showStat;
    if (!match) {
      showStat = new ShowStatistic({ name: show.name });
    } else {
      showStat = this.statistics[idx];
    }

    showStat.add(downloadInfo);

    if (!match) {
      this.statistics.push(showStat);
    } else {
      this.statistics[idx] = showStat;
    }

    this.writeFile(this.file('statistics.json'), this.statistics);
  }

  getShowsWithStats(shows) {
    return shows.map((show) => {
      const downloads = (
        this.statistics.find((s) => s.name === show.name) || {
          downloads: [],
        }
      ).downloads;

      return {
        show,
        downloads,
      };
    });
  }

  cleanName(name) {
    return name.replace('!', '').toLowerCase();
  }

  addShow(show, source) {
    this.logDebug(`Adding ${show} to rss.`);
    let newShows = 0;
    if (Array.isArray(show)) {
      show = show.map((s) => this.cleanName(s));
      show = show.map((s) => this.getShow(s));
      show = show.filter((s) => this.settings.shows.indexOf(s) === -1);
      show = show.filter((s) => !this.removedShows.includes(s));

      if (show.length === 0) {
        this.logDebug('Skipping show -- invalid name');
        return;
      }

      this.settings.shows = [...this.settings.shows, ...show];
      newShows = show.map((s) => s.Name).join(', ');
    } else if (!this.removedShows.map((s) => s.name).includes(show)) {
      newShows = typeof show === 'string' ? show : show.name;
      this.settings.shows.push(this.getShow(show));
    }

    if (newShows) {
      if (source) {
        this.logAddition(`Added ${newShows} to list from ${source}.`);
      } else {
        this.logAddition(`Added ${newShows} to list.`);
      }
    }

    this.saveSettings(this.settings);
  }

  removeShow(show) {
    let removedShows;
    if (Array.isArray(show)) {
      show = show.map((s) => this.cleanName(s));
      show = show.filter((s) => this.settings.shows.indexOf(s) > -1);

      if (show.length === 0) {
        return;
      }

      show.map((s) => this.settings.shows.indexOf(s));

      show.forEach((index) => this.settings.shows.splice(index, 1));

      this.removedShows.push(...show);

      removedShows = show.join(', ');
    } else {
      removedShows = show;
      show = this.settings.shows.splice(
        this.settings.shows.indexOf(show),
        1
      )[0];
      if (!this.removedShows.map((r) => r.name).includes(show.name)) {
        this.removedShows.push(show);
      }
    }

    if (removedShows) {
      this.logRemoval(`Removed ${removedShows} from list.`);
      this.saveSettings(this.settings);
      this.writeFile(this.file('removedshows.json'), this.removedShows);
    }
  }

  restoreShow(show) {
    const removedIndex = this.removedShows.map((r) => r.name).indexOf(show);
    const restored = this.removedShows.splice(removedIndex, 1)[0];

    this.writeFile(this.file('removedshows.json'), this.removedShows);

    this.addShow(restored);
  }

  getSavePath(entry) {
    const settings = this.settings;
    let dir;
    if (settings.sort == false) {
      dir = `${settings.saveTo}`;
    } else {
      dir = `${settings.saveTo}\\${entry.title}`;
    }
    return dir;
  }

  getShow(show) {
    try {
      if (typeof show === 'string') {
        return new Show({ name: this.cleanName(show) });
      }
      return new Show(show);
    } catch (e) {
      this.logError(e);
    }
  }
};
