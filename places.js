// Your saved places, stations and stops. Edit freely in GitHub.
// Coordinates are approximate: check them on openstreetmap.org
// (right-click a spot -> "Show address" gives lat/lon).
// You can also save places, stations and stops from inside the app (the SAVE / star buttons).

window.NAV_CONFIG = {
  // Used to bias place searches when there's no GPS fix yet (Guildford town centre)
  centre: { lat: 51.2362, lon: -0.5715 },

  places: [
    { name: 'Guildford Station', lat: 51.2369, lon: -0.5803 },
    { name: 'Guildford High Street', lat: 51.2361, lon: -0.5715 },
    // { name: 'Home', lat: 51.0000, lon: -0.5000 },
    // { name: 'Oakleaf', lat: 51.0000, lon: -0.5000 },
  ],

  // Three-letter station codes (CRS)
  stations: [
    { crs: 'GLD', name: 'Guildford' },
    { crs: 'WOK', name: 'Woking' },
  ],

  // Bus stops by ATCO code (OpenStreetMap tag "naptan:AtcoCode", or the code on a bustimes.org stop page)
  stops: [
    // { atco: '4000XXXXXXXX', name: 'Friary Bus Station (Stand 1)' },
  ],
};
