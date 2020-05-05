const Rss = require('rss-parser');
const ptt = require('parse-torrent-title');
const fs = require('fs-extra');
const path = require('path');

const ShowStatistic = require('./Entities/ShowStatistics');
const { extractRootDomain } = require('./helpers');

const rss = new Rss();
const emitter = global.emitter;
module.exports = class TorrentRSS {
  constructor() {
    this.construct(__dirname);
    /** @type {String[]} */
    this.downloadList = [];
    /** @type {String[]} */
    this.removedShows = [];
    /** @type {ShowStatistic[]} */
    this.statistics = [];
  }

  file(filename) {
    return `torrentrss_${filename}`;
  }

  setup() {
    this.settings.shows = this.settings.shows.map((s) => s.toLowerCase());

    this.setupListeners();
    this.loadRemovedShows();
    this.loadStatistics();

    emitter.emit(
      'message',
      `Started Torrent RSS feed timer (${this.settings.updateInterval}m)`,
      'start',
      TorrentRSS.name
    );

    this.checkFeeds();

    setTimeout(() => {
      if (global.Ninjakatt.plugins.has('Webserver')) {
        this.addWebroutes();
      }
    }, 0);
  }

  feedTimer() {
    setTimeout(() => {
      this.checkFeeds();
    }, this.settings.updateInterval * 1000 * 60);
  }

  checkFeeds() {
    const settings = this.settings;
    const showsToDownload = settings.shows || [];
    const feeds = settings.feeds;

    feeds.forEach(async (feedUrl) => {
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
          title: entry.title.toLowerCase(),
          savePath: this.getSavePath(entry),
        }));

      // Remove files already downloaded
      feed = feed.filter(
        (entry) => !this.downloadList.includes(entry.fileName)
      );

      // Remove entries not in the download list
      feed = feed.filter((entry) => showsToDownload.includes(entry.title));

      // Remove incorrect resolutions
      feed = feed.filter((entry) => entry.resolution === settings.resolution);

      // Remove incorrect sources
      feed = feed.filter(
        (entry) =>
          entry.source === settings.source.toLowerCase() ||
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
            (file) => file.title.toLowerCase() === entry.title.toLowerCase()
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
    this.removedShows = this.readFile(this.file('removedshows.json')) || [];
  }

  async loadStatistics() {
    this.statistics = this.readFile(this.file('statistics.json')) || [];

    if (this.statistics.length) {
      this.statistics = this.statistics.map((show) => new ShowStatistic(show));
    }
  }

  updateStatsForShow(show, downloadInfo) {
    const idx = this.statistics.findIndex((stat) => stat.name === show);
    const match = idx === -1 ? false : true;

    /** @type {ShowStatistic} */
    let showStat;
    if (!match) {
      showStat = new ShowStatistic({ name: show });
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
    return shows.map((name) => {
      const downloads = (
        this.statistics.find((s) => s.name === name) || {
          downloads: [],
        }
      ).downloads;

      return {
        name,
        downloads,
      };
    });
  }

  addWebroutes() {
    const prefix = TorrentRSS.name.toLowerCase();

    emitter.emit(
      'webserver.add-route',
      'get',
      `/${prefix}/shows`,
      (req, res) => {
        res.status(200).send(this.getShowsWithStats(this.settings.shows));
      }
    );

    emitter.emit(
      'webserver.add-route',
      'get',
      `/${prefix}/removed-shows`,
      (req, res) => {
        res.status(200).send(this.getShowsWithStats(this.removedShows));
      }
    );

    emitter.emit(
      'webserver.add-route',
      'post',
      `/${prefix}/shows`,
      (req, res) => {
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
        res.status(200).send(this.settings.shows);
      }
    );

    emitter.emit(
      'webserver.add-route',
      'delete',
      `/${prefix}/shows`,
      (req, res) => {
        const show = req.query.show;
        if (!show || this.settings.shows.indexOf(show) === -1) {
          return;
        }
        this.removeShow(show);
        res.status(200).send(this.settings.shows);
      }
    );

    emitter.emit(
      'webserver.add-route',
      'delete',
      `/${prefix}/removed-shows`,
      (req, res) => {
        const show = req.query.show;
        if (!show || !this.removedShows.includes(show)) {
          return;
        }
        this.restoreShow(show);
        res.status(200).send(this.settings.shows);
      }
    );
  }

  addShow(show, source) {
    let newShows = 0;
    if (Array.isArray(show)) {
      show = show.map((s) => s.toLowerCase());
      show = show.filter((s) => this.settings.shows.indexOf(s) === -1);
      show = show.filter((s) => !this.removedShows.includes(s));

      if (show.length === 0) {
        return;
      }

      this.settings.shows = [...this.settings.shows, ...show];
      newShows = show.join(', ');
    } else if (!this.removedShows.includes(show)) {
      newShows = show;
      this.settings.shows.push(show);
    }

    if (newShows) {
      let message = `Added ${newShows} to list.`;

      if (source) {
        message = message.replace(/(.*)\.$/, `$1 from ${source}.`);
      }

      emitter.emit('message', message, 'add', TorrentRSS.name);
    }

    this.saveSettings(this.settings);
  }

  removeShow(show) {
    let removedShows;
    if (Array.isArray(show)) {
      show = show.map((s) => s.toLowerCase());
      show = show.filter((s) => this.settings.shows.indexOf(s) > -1);

      if (show.length === 0) {
        return;
      }

      shows.map((s) => this.settings.shows.indexOf(s));

      shows.forEach((index) => this.settings.shows.splice(index, 1));

      this.removedShows.push(...shows);

      removedShows = show.join(', ');
    } else {
      removedShows = show;
      if (!this.removedShows.includes(show)) {
        this.removedShows.push(show);
      }
      this.settings.shows.splice(this.settings.shows.indexOf(show), 1);
    }

    if (removedShows) {
      emitter.emit(
        'message',
        `Removed ${removedShows} from list.`,
        'remove',
        TorrentRSS.name
      );

      this.saveSettings(this.settings);
      this.writeFile(this.file('removedshows.json'), this.removedShows);
    }
  }

  restoreShow(show) {
    const removedIndex = this.removedShows.indexOf(show);
    this.removedShows.splice(removedIndex, 1);
    this.writeFile(this.file('removedshows.json'), this.removedShows);

    this.addShow(show);
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

  setupListeners() {
    emitter.register(
      'torrentrss.add-show',
      (show, source) => {
        this.addShow(show, source);
        return Promise.resolve(this.settings.shows);
      },
      TorrentRSS.name
    );
  }
};
