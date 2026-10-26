const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

//Run browser services with isolated storage and messaging, without fetching model files.
function setup(storage = new Map()) {
  const messages = []
  const context = {
    Audio: class {}, addEventListener() {},
    parent: {postMessage: message => messages.push(message)},
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  }
  function load(name, dependencies = {}) {
    const exports = {}
    const source = fs.readFileSync(path.join(__dirname, '../src', name + '.ts'), 'utf8')
    const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021}}).outputText
    vm.runInNewContext(code, {...context, exports, require: key => {
      assert.ok(key in dependencies, `Unexpected import: ${key}`)
      return dependencies[key]
    }})
    return exports
  }
  const config = load('config')
  const services = load('services', {
    './config': config,
    './utils': {immediate: fn => fn()},
    '@lsdsoftware/message-dispatcher': {makeDispatcher: () => ({})},
  })
  const voice = {
    id: 'donated_voice', label: 'Donated Voice',
    clip: config.default.voicesRepoPath + '/voice-donations/donated_voice.wav',
    license: 'CC0', source: 'Unmute Voice Donation Project', sourceUrl: 'https://unmute.sh/voice-donation',
  }
  return {services, voice, storage, messages, context}
}

test('saved donation survives reload, resolves advertised voice name, and is removed persistently', () => {
  const first = setup()
  first.services.saveAddedVoices([first.voice])
  const next = setup(first.storage)
  const restored = next.services.loadAddedVoices()
  assert.equal(restored.length, 1)
  restored.forEach(next.services.registerVoice)
  next.services.advertiseVoices(restored, 'en')
  const advertised = next.messages[0].args.voices[0]
  assert.equal(advertised.voiceName, 'PocketTTS donated_voice')
  assert.equal(advertised.lang, 'en')
  assert.equal(next.services.getVoice(next.services.parseAdvertisedVoiceName(advertised.voiceName)).clip, first.voice.clip)
  next.services.saveAddedVoices([])
  next.services.advertiseVoices(next.services.loadAddedVoices(), 'en')
  assert.equal(next.messages[1].args.voices.length, 0)
  assert.equal(setup(first.storage).services.loadAddedVoices().length, 0)
})

test('malformed data is ignored and duplicate donations are restored only once', () => {
  const {services, storage, voice} = setup()
  storage.set(services.addedVoicesStorageKey, '{')
  assert.equal(services.loadAddedVoices().length, 0)
  storage.set(services.addedVoicesStorageKey, JSON.stringify([null, {}, voice, voice, {...voice, id: 'bad id'}, {...voice, clip: 'https://example.com/clip.wav'}]))
  assert.equal(services.loadAddedVoices().length, 1)
})

test('unavailable storage can be read safely but failed writes are reported', () => {
  const {services, context, voice} = setup()
  context.localStorage.getItem = () => {throw Error('Storage blocked')}
  context.localStorage.setItem = () => {throw Error('Storage blocked')}
  assert.equal(services.loadAddedVoices().length, 0)
  assert.throws(() => services.saveAddedVoices([voice]), /Storage blocked/)
})

test('the same saved voice is advertised in the selected model language', () => {
  const {services, voice, messages} = setup()
  //Legacy saved voice languages must not override the current model's language.
  services.saveAddedVoices([{...voice, lang: 'en-US'}])
  const restored = services.loadAddedVoices()
  assert.equal('lang' in restored[0], false)
  services.advertiseVoices(restored, 'en')
  services.advertiseVoices(restored, 'fr')
  assert.equal(messages[0].args.voices[0].lang, 'en')
  assert.equal(messages[1].args.voices[0].lang, 'fr')
  assert.equal(messages[0].args.voices[0].voiceName, messages[1].args.voices[0].voiceName)
})
