// Standalone stand-in for the Tableau Extensions API: serves the bundled data to the same code the extension used.
window.tableau = {
  TableauEventType: { SummaryDataChanged: 'summary-data-changed' },
  extensions: {
    initializeAsync: function () { return Promise.resolve(); },
    worksheetContent: { worksheet: {
      addEventListener: function () {},
      getSummaryDataAsync: function () { return Promise.resolve(window.NFL_DATA); }
    } }
  }
};
