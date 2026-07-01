'use strict';
/**
 * User configuration. THIS is the only file you edit to adapt the analyzer
 * to your app. Nothing in lib/ hardcodes product names — every rule below is
 * data the engines consume.
 */
module.exports = {
  // Inputs. Override from CLI:
  //   node analyze.js before.heapsnapshot after.heapsnapshot run.heaptimeline
  //   node analyze.js --dir path/to/snapshots run.heaptimeline
  inputs: {
    snapshots: [],         // ordered .heapsnapshot/.heapdump files
    snapshot: null,        // optional single final snapshot fallback
    snapshotsDir: null,    // directory of .heapsnapshot/.heapdump files
    timeline: null,        // .heaptimeline with allocation stack traces
  },

  // Business mapping — turn generic DOM/edge names into your product modules.
  business: {
    // CSS class prefix -> product module. Used to label detached DOM.
    classPrefixes: {
      // example entries — replace/augment with your own:
      'bpx-': 'player',
      'bili-': 'bilibili',
    },
    // Regexes that extract a business key from a DOM class string (first
    // capture group wins). More specific than the prefix map.
    classKeyExtractors: [
      /(bili-[\w-]+)/i,
      /(bpx-[\w-]+)/i,
    ],
    // Edge-name -> semantic hint shown in leak-mechanism line.
    edgeSemantics: {
      // example: 'dummyAudio': 'audio fallback placeholder',
    },
  },

  // Built-in framework detection rules. Add customFrameworks below for in-house frameworks.
  frameworks: ['vue2', 'vue3', 'react'],

  // Optional inline custom rule. Keep it here so lib/ stays one-file small.
  // customFrameworks: [{
  //   name: 'myfw',
  //   detect: (node, H) => H.hasRef(node, '_myFrameworkTag'),
  //   nameFrom: (node, H) => H.pickStr(node.getReferenceNode('$options'), ['name', '__file']),
  // }],
  customFrameworks: [],

  // Leak-mechanism heuristics — referrer blink type regex -> human hint.
  // Extend with your own SDK/library signatures.
  leakMechanisms: [
    { match: /IntersectionObserv|ResizeObserv|MutationObserv|PerformanceObserv/, hint: 'observer not disconnected' },
    { match: /EventTargetData|RegisteredEventListener|EventListenerMap/, hint: 'event listener not removed' },
    { match: /CueTimeline|TextTrack|MediaEncod|MediaSource|RemotePlayback|MediaKeys/, hint: 'held by HTMLMediaElement API' },
    { match: /Promise|Pending activities|AsyncFunction/, hint: 'pending async work' },
    // { match: /YourSDK/, hint: 'YourSDK cache' },
  ],

  // Sustained retained-size growth tuning. thresholdBytes is minimum positive delta.
  unboundGrowth: { minSnapshots: 2, thresholdBytes: 1024, maxResults: 50 },

  report: { maxDetachedDom: 20, maxTopHolders: 20, maxDuplicateStrings: 20 },
};
