const path = require('path')
const CopyPlugin = require('copy-webpack-plugin')

module.exports = (env, argv) => ({
  entry: './src/index.tsx',
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
    filename: 'bundle.js',
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        'dist',
        { from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', to: '[name][ext]' }
      ]
    })
  ],
})
