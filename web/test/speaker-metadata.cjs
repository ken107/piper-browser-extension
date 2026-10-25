const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const {test} = require('node:test')
const ts = require('typescript')

function loadServices(files) {
  const exports = {}
  const dependencies = {
    '@lsdsoftware/message-dispatcher': {makeDispatcher: () => ({})},
    './config': {default: {voiceList: {file: 'voices.json'}, excludeVoices: new Set()}},
    './storage': {getFile: async name => {
      if (!files.has(name)) throw new DOMException('Missing file', 'NotFoundError')
      return files.get(name)
    }},
    './utils': {immediate: fn => fn()},
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/services.ts'), 'utf8')
  const {outputText} = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020},
  })
  vm.runInNewContext(outputText, {
    exports, require: name => dependencies[name], Blob, File, DOMException,
    Audio: class {}, addEventListener() {}, console,
  })
  return exports
}

const key = 'en_US-libritts_r-medium'
const catalogVoice = {
  key, name: 'libritts_r', language: {code: 'en_US', name_native: 'English'},
  num_speakers: 2306, speaker_id_map: {'17': 348, '104': 1148},
  files: {'model.onnx': {size_bytes: 81472438}},
}
function fixture(modelConfig) {
  return new Map([
    ['voices.json', new Blob([JSON.stringify({[key]: catalogVoice})])],
    [key + '.onnx', new Blob(['model'])],
    [key + '.json', new Blob([JSON.stringify(modelConfig)])],
  ])
}

test('installed model overrides stale catalog IDs, counts and advertised speakers', async () => {
  const services = loadServices(fixture({num_speakers: 904, speaker_id_map: {'17': 805, '2': 7}}))
  const [voice] = await services.getVoiceList()
  assert.equal(voice.installState, 'installed')
  assert.equal(voice.num_speakers, 904)
  assert.equal(voice.speaker_id_map['17'], 805)
  assert.equal(voice.speaker_id_map['104'], undefined)
  assert.equal(JSON.stringify(voice.speakerList), JSON.stringify([
    {speakerName: '2', speakerId: 7}, {speakerName: '17', speakerId: 805},
  ]))
  const advertised = services.makeAdvertisedVoiceList([voice])
  assert.equal(advertised.length, 2)
  assert.ok(advertised.some(x => x.voiceName.includes(' 17 ')))
  assert.ok(!advertised.some(x => x.voiceName.includes(' 104 ')))
})

test('single-speaker config clears stale catalog speakers', async () => {
  const services = loadServices(fixture({num_speakers: 1, speaker_id_map: {}}))
  const [voice] = await services.getVoiceList()
  assert.equal(voice.speakerList.length, 0)
  assert.equal(services.makeAdvertisedVoiceList([voice])[0].voiceName, 'Piper libritts_r-medium (English)')
})

test('model without its configuration is not advertised as installed', async () => {
  const files = fixture({num_speakers: 904})
  files.delete(key + '.json')
  const services = loadServices(files)
  const voices = await services.getVoiceList()
  assert.equal(voices[0].installState, 'not-installed')
  assert.equal(services.makeAdvertisedVoiceList(voices).length, 0)
})

test('new installation exposes model metadata before a reload', async () => {
  const services = loadServices(fixture({num_speakers: 904, speaker_id_map: {'17': 805}}))
  const {modelConfig} = await services.installVoice(catalogVoice, () => {})
  const voice = {...catalogVoice, ...services.getSpeakerMetadata(modelConfig, catalogVoice), installState: 'installed'}
  assert.equal(voice.speaker_id_map['17'], 805)
  assert.equal(voice.num_speakers, 904)
  assert.equal(services.makeAdvertisedVoiceList([voice]).length, 1)
})


test('absent model speaker map falls back to catalog on reload and installation', async () => {
  const services = loadServices(fixture({num_speakers: 2306}))
  const [voice] = await services.getVoiceList()
  assert.equal(voice.speaker_id_map['17'], 348)
  assert.equal(voice.speaker_id_map['104'], 1148)
  assert.equal(services.makeAdvertisedVoiceList([voice]).length, 2)
  const {modelConfig} = await services.installVoice(catalogVoice, () => {})
  const metadata = services.getSpeakerMetadata(modelConfig, catalogVoice)
  assert.equal(metadata.speaker_id_map['17'], 348)
  assert.equal(metadata.speakerList.length, 2)
})
