const path = require('path');
module.exports = {
  PORT: process.env.PORT || 8787,
  PUBLIC_DIR: path.resolve('public'),
  DATA_DIR: path.resolve('data'),
  FAPI: 'https://fapi.binance.com',
  ENDPT: {
    exchangeInfo: '/fapi/v1/exchangeInfo',
    tickers: '/fapi/v1/ticker/price',
    premiumAll: '/fapi/v1/premiumIndex',
    openInterest: '/fapi/v1/openInterest?symbol='
  }
};
