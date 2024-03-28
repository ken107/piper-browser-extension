const path = require('path')
const CopyPlugin = require('copy-webpack-plugin')
const BundleAnalyzerPlugin = require('webpack-bundle-analyzer').BundleAnalyzerPlugin

module.exports = (env, argv) => ({
  entry: {
    main: {
      import: './src/index.tsx',
      filename: 'bundle.js',
    },
    inferenceWorker: {
      import: './src/inference-worker.ts',
      filename: 'inference-worker.js',
    },
  },
  devtool: argv.mode == 'production' ? undefined : 'source-map',
  module: {
    rules: [
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
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        'dist',
        { from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', to: '[name][ext]' },
        { from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd.wasm', to: '[name][ext]' },
      ]
    }),
    ...(env.analyze ? [new BundleAnalyzerPlugin()] : [])
  ],
})
