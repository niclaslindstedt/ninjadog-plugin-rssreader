const Base = require('ninjakatt-plugin-base');
const Rss = require('rss-parser');
const ptt = require('parse-torrent-title');
const fs = require('fs-extra');
const path = require('path');

const rss = new Rss();
const emitter = global.emitter;
module.exports = class TorrentRSS extends Base {
  constructor() {
    super(__dirname);
  }

  setup() {
    this.setupListeners();
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
    const feeds = settings.feeds;
    const shows = settings.shows.map(show => show.toLowerCase());

    feeds.forEach(async feed => {
      feed = await rss.parseURL(feed);

      // Add info to entries
      feed = feed.items
        .reverse()
        .map(entry => ({
          ...entry,
          release: entry.title.replace(/\s/g, '.'),
          ...ptt.parse(entry.title)
        }))
        .map(entry => ({
          ...entry,
          fileName: `${entry.release}.torrent`,
          title: entry.title.toLowerCase(),
          savePath: this.getSavePath(entry)
        }));

      // Remove entries not in the download list
      feed = feed.filter(entry => shows.indexOf(entry.title) > -1);

      // Remove incorrect resolutions
      feed = feed.filter(entry => entry.resolution === settings.resolution);

      // Remove incorrect sources
      feed = feed.filter(
        entry =>
          entry.source === settings.source.toLowerCase() ||
          settings.source === ''
      );

      // Remove foreign if not wanted
      if (settings.skipForeign === true) {
        feed = feed.filter(
          entry =>
            entry.categories ? entry.categories.indexOf('Foreign') === -1 : true
        );
      }

      // Remove packs if not wanted
      if (settings.skipPacks === true) {
        feed = feed.filter(entry => !!entry.episode);
      }

      // Check local files and remove duplicates if not proper or repack
      feed = feed.filter(entry => {
        fs.ensureDirSync(entry.savePath);
        let files = fs
          .readdirSync(entry.savePath)
          .map(file => ({
            file: file.toLowerCase(),
            ...ptt.parse(file),
            time: fs
              .statSync(path.resolve(entry.savePath, file))
              .mtime.getTime()
          }))
          .filter(file => file.title.toLowerCase() === entry.title)
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
            e =>
              e &&
              entry &&
              entry.title === e.title &&
              entry.season === e.season &&
              entry.episode === e.episode
          ).length > 1
        );
      }

      // Download remaining torrents
      feed.forEach(entry => {
        emitter.emit(
          'file.download',
          entry.link,
          path.resolve(entry.savePath, entry.fileName)
        );
      });
    });

    this.feedTimer();
  }

  setupListeners() {
    emitter.register(
      'torrentrss.add-show',
      show => {
        let newShows = 0;
        if (typeof show === 'object') {
          show = show.filter(s => this.settings.shows.indexOf(s) === -1);
          this.settings.shows = [...this.settings.shows, ...show];
          newShows = show.length;
        } else {
          newShows = 1;
          this.settings.shows.push(show);
        }

        if (newShows > 0) {
          emitter.emit(
            'message',
            `Added ${newShows} show/s to torrent rss list.`,
            'add',
            TorrentRSS.name
          );
        }

        return Promise.resolve(this.settings.shows);
      },
      TorrentRSS.name
    );
  }

  addWebroutes() {
    const prefix = TorrentRSS.name.toLowerCase();

    emitter.emit(
      'webserver.add-route',
      'get',
      `/${prefix}/shows`,
      (req, res) => {
        res.status(200).send(this.settings.shows);
      }
    );
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
};
