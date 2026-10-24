const path = require('path')
const CopyPlugin = require('copy-webpack-plugin')
const BundleAnalyzerPlugin = require('webpack-bundle-analyzer').BundleAnalyzerPlugin

module.exports = (env, argv) => ({
  entry: {
    main: {
      import: './src/index.tsx',
      filename: 'bundle.js',
    },
    serviceWorker: {
      import: './src/service-worker.ts',
      filename: 'sw.js',
    }
  },
  devtool: argv.mode == 'production' ? undefined : 'source-map',
  module: {
    rules: [
      {
        //ORT references its .wasm/.mjs via new URL(..., import.meta.url), but we load them
        //from jsDelivr (env.wasm.wasmPaths), so don't emit local copies
        test: /node_modules[\\/]onnxruntime-web[\\/]/,
        parser: { url: false },
      },
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  output: {
    path: path.resolve(__dirname, 'build', argv.mode == 'production' ? 'release' : 'debug'),
    //remove stale files from earlier builds (e.g. piper_phonemize.*), keep the local test server
    clean: { keep: /^serve\.py$/ },
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        'dist',
      ]
    }),
    ...(env.analyze ? [new BundleAnalyzerPlugin()] : [])
  ],
  watchOptions: {
    aggregateTimeout: 600,
    ignored: /node_modules/
  }
})
