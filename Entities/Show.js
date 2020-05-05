module.exports = class Show {
  constructor({ name, copyTo = '', tracker = '*' }) {
    /**
     * @type {String}
     * @description Name of the show (e.g. 'Free TV Show')
     */
    this.name = name;

    /**
     * @type {String}
     * @description Destination path (e.g. 'D:\shows\Free TV Show (2010)\')
     */
    this.copyTo = copyTo;

    /**
     * @type {String}
     * @description Domain of tracker without tld (e.g. 'google' for 'google.com')
     */
    this.tracker = tracker;
  }
};
