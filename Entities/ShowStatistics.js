module.exports = class ShowStatistics {

  constructor({ name, downloads }) {
    /** @type {String} */
    this.name = name;
    /** @type {Download[]} */
    this.downloads = downloads ? downloads.map((d) => new Download(d)) : [];
    this.downloads;
  }

  /**
   * Add download to statistics
   * @param {Download} details
   */
  add(details) {
    this.downloads.push(details);
  }

};

class Download {

  constructor({ date, tracker }) {
    this.date = date;
    this.tracker = tracker;
  }

}
