// @bun
// node_modules/@aeriondyseti/hook-kit/dist/chunk-4Q2GZ36G.js
import { writeSync } from "fs";
import { readFileSync } from "fs";
var _CAPTURED_SENTINEL = /* @__PURE__ */ Symbol("hook-kit:captured");
var _capture;
function emitJson(payload, exitCode = 0) {
  return emitRaw(payload, JSON.stringify(payload), exitCode);
}
function emitText(text, exitCode = 0) {
  return emitRaw(text, text, exitCode);
}
function emitRaw(payload, serialized, exitCode) {
  if (_capture) {
    _capture.payload = payload;
    _capture.exitCode = exitCode;
    throw _CAPTURED_SENTINEL;
  }
  writeSync(1, serialized);
  process.exit(exitCode);
}
var HOOK_EVENT_NAMES = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Notification",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PreModelSwitch",
  "PostModelSwitch",
  "PermissionRequest",
  "PermissionDenied",
  "Setup",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "Elicitation",
  "ElicitationResult",
  "ConfigChange",
  "WorktreeCreate",
  "WorktreeRemove",
  "InstructionsLoaded",
  "CwdChanged",
  "FileChanged",
  "DirectoryAdded",
  "MessageDisplay"
];
var _testStdin;
function readStdinSync() {
  if (_testStdin !== undefined)
    return _testStdin;
  return readFileSync(0, "utf8");
}
var HookParseError = class extends Error {
  constructor(parseError) {
    super(`hook-kit: ${parseError}`);
    this.parseError = parseError;
    this.name = "HookParseError";
  }
  parseError;
  exitCode = 2;
};
function readHookInput(expected) {
  const raw = readStdinSync();
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new HookParseError(`failed to parse stdin as JSON (${e.message})`);
  }
  if (json.hook_event_name !== expected) {
    throw new HookParseError(`this script expects a ${expected} hook, but got hook_event_name="${json.hook_event_name}". Check settings.json \u2014 the script is wired to the wrong event.`);
  }
  return json;
}

// node_modules/ansi-regex/index.js
function ansiRegex({ onlyFirst = false } = {}) {
  const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
  const osc = `(?:(?:\\u001B\\]|\\u009D)[^\\u0007\\u001B\\u009C\\u009D]*${ST})`;
  const csi = "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
  const pattern = `${osc}|${csi}`;
  return new RegExp(pattern, onlyFirst ? undefined : "g");
}

// node_modules/strip-ansi/index.js
var regex = ansiRegex();
function stripAnsi(string) {
  if (typeof string !== "string") {
    throw new TypeError(`Expected a \`string\`, got \`${typeof string}\``);
  }
  if (!string.includes("\x1B") && !string.includes("\x9B")) {
    return string;
  }
  return string.replace(regex, "");
}

// node_modules/get-east-asian-width/lookup-data.js
var ambiguousMinimalCodePoint = 161;
var ambiguousMaximumCodePoint = 1114109;
var ambiguousRanges = [161, 161, 164, 164, 167, 168, 170, 170, 173, 174, 176, 180, 182, 186, 188, 191, 198, 198, 208, 208, 215, 216, 222, 225, 230, 230, 232, 234, 236, 237, 240, 240, 242, 243, 247, 250, 252, 252, 254, 254, 257, 257, 273, 273, 275, 275, 283, 283, 294, 295, 299, 299, 305, 307, 312, 312, 319, 322, 324, 324, 328, 331, 333, 333, 338, 339, 358, 359, 363, 363, 462, 462, 464, 464, 466, 466, 468, 468, 470, 470, 472, 472, 474, 474, 476, 476, 593, 593, 609, 609, 708, 708, 711, 711, 713, 715, 717, 717, 720, 720, 728, 731, 733, 733, 735, 735, 768, 879, 913, 929, 931, 937, 945, 961, 963, 969, 1025, 1025, 1040, 1103, 1105, 1105, 8208, 8208, 8211, 8214, 8216, 8217, 8220, 8221, 8224, 8226, 8228, 8231, 8240, 8240, 8242, 8243, 8245, 8245, 8251, 8251, 8254, 8254, 8308, 8308, 8319, 8319, 8321, 8324, 8364, 8364, 8451, 8451, 8453, 8453, 8457, 8457, 8467, 8467, 8470, 8470, 8481, 8482, 8486, 8486, 8491, 8491, 8531, 8532, 8539, 8542, 8544, 8555, 8560, 8569, 8585, 8585, 8592, 8601, 8632, 8633, 8658, 8658, 8660, 8660, 8679, 8679, 8704, 8704, 8706, 8707, 8711, 8712, 8715, 8715, 8719, 8719, 8721, 8721, 8725, 8725, 8730, 8730, 8733, 8736, 8739, 8739, 8741, 8741, 8743, 8748, 8750, 8750, 8756, 8759, 8764, 8765, 8776, 8776, 8780, 8780, 8786, 8786, 8800, 8801, 8804, 8807, 8810, 8811, 8814, 8815, 8834, 8835, 8838, 8839, 8853, 8853, 8857, 8857, 8869, 8869, 8895, 8895, 8978, 8978, 9312, 9449, 9451, 9547, 9552, 9587, 9600, 9615, 9618, 9621, 9632, 9633, 9635, 9641, 9650, 9651, 9654, 9655, 9660, 9661, 9664, 9665, 9670, 9672, 9675, 9675, 9678, 9681, 9698, 9701, 9711, 9711, 9733, 9734, 9737, 9737, 9742, 9743, 9756, 9756, 9758, 9758, 9792, 9792, 9794, 9794, 9824, 9825, 9827, 9829, 9831, 9834, 9836, 9837, 9839, 9839, 9886, 9887, 9919, 9919, 9926, 9933, 9935, 9939, 9941, 9953, 9955, 9955, 9960, 9961, 9963, 9969, 9972, 9972, 9974, 9977, 9979, 9980, 9982, 9983, 10045, 10045, 10102, 10111, 11094, 11097, 12872, 12879, 57344, 63743, 65024, 65039, 65533, 65533, 127232, 127242, 127248, 127277, 127280, 127337, 127344, 127373, 127375, 127376, 127387, 127404, 917760, 917999, 983040, 1048573, 1048576, 1114109];
var fullwidthMinimalCodePoint = 12288;
var fullwidthMaximumCodePoint = 65510;
var fullwidthRanges = [12288, 12288, 65281, 65376, 65504, 65510];
var wideMinimalCodePoint = 4352;
var wideMaximumCodePoint = 262141;
var wideRanges = [4352, 4447, 8986, 8987, 9001, 9002, 9193, 9196, 9200, 9200, 9203, 9203, 9725, 9726, 9748, 9749, 9776, 9783, 9800, 9811, 9855, 9855, 9866, 9871, 9875, 9875, 9889, 9889, 9898, 9899, 9917, 9918, 9924, 9925, 9934, 9934, 9940, 9940, 9962, 9962, 9970, 9971, 9973, 9973, 9978, 9978, 9981, 9981, 9989, 9989, 9994, 9995, 10024, 10024, 10060, 10060, 10062, 10062, 10067, 10069, 10071, 10071, 10133, 10135, 10160, 10160, 10175, 10175, 11035, 11036, 11088, 11088, 11093, 11093, 11904, 11929, 11931, 12019, 12032, 12245, 12272, 12287, 12289, 12350, 12353, 12438, 12441, 12543, 12549, 12591, 12593, 12686, 12688, 12773, 12783, 12830, 12832, 12871, 12880, 42124, 42128, 42182, 43360, 43388, 44032, 55203, 63744, 64255, 65040, 65049, 65072, 65106, 65108, 65126, 65128, 65131, 94176, 94180, 94192, 94198, 94208, 101594, 101631, 101664, 101760, 101874, 101888, 102801, 102816, 102866, 110576, 110579, 110581, 110587, 110589, 110590, 110592, 110888, 110898, 110898, 110928, 110930, 110933, 110933, 110948, 110952, 110960, 111355, 119552, 119638, 119648, 119670, 126980, 126980, 127183, 127183, 127374, 127374, 127377, 127386, 127406, 127406, 127488, 127490, 127504, 127547, 127552, 127560, 127568, 127569, 127584, 127589, 127744, 127776, 127789, 127797, 127799, 127868, 127870, 127891, 127904, 127946, 127951, 127955, 127968, 127984, 127988, 127988, 127992, 128062, 128064, 128064, 128066, 128252, 128255, 128317, 128331, 128334, 128336, 128359, 128378, 128378, 128405, 128406, 128420, 128420, 128507, 128591, 128640, 128709, 128716, 128716, 128720, 128722, 128725, 128729, 128732, 128735, 128747, 128748, 128756, 128764, 128986, 128986, 128992, 129003, 129008, 129008, 129292, 129338, 129340, 129349, 129351, 129535, 129648, 129660, 129664, 129734, 129736, 129736, 129740, 129757, 129759, 129771, 129775, 129786, 131072, 196605, 196608, 262141];

// node_modules/get-east-asian-width/utilities.js
var isInRange = (ranges, codePoint) => {
  let low = 0;
  let high = Math.floor(ranges.length / 2) - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const i = mid * 2;
    if (codePoint < ranges[i]) {
      high = mid - 1;
    } else if (codePoint > ranges[i + 1]) {
      low = mid + 1;
    } else {
      return true;
    }
  }
  return false;
};

// node_modules/get-east-asian-width/lookup.js
var commonCjkCodePoint = 19968;
var [wideFastPathStart, wideFastPathEnd] = /* @__PURE__ */ findWideFastPathRange(wideRanges);
function findWideFastPathRange(ranges) {
  let fastPathStart = ranges[0];
  let fastPathEnd = ranges[1];
  for (let index = 0;index < ranges.length; index += 2) {
    const start = ranges[index];
    const end = ranges[index + 1];
    if (commonCjkCodePoint >= start && commonCjkCodePoint <= end) {
      return [start, end];
    }
    if (end - start > fastPathEnd - fastPathStart) {
      fastPathStart = start;
      fastPathEnd = end;
    }
  }
  return [fastPathStart, fastPathEnd];
}
var isAmbiguous = (codePoint) => {
  if (codePoint < ambiguousMinimalCodePoint || codePoint > ambiguousMaximumCodePoint) {
    return false;
  }
  return isInRange(ambiguousRanges, codePoint);
};
var isFullwidth = (codePoint) => {
  if (codePoint < fullwidthMinimalCodePoint || codePoint > fullwidthMaximumCodePoint) {
    return false;
  }
  return isInRange(fullwidthRanges, codePoint);
};
var isWide = (codePoint) => {
  if (codePoint >= wideFastPathStart && codePoint <= wideFastPathEnd) {
    return true;
  }
  if (codePoint < wideMinimalCodePoint || codePoint > wideMaximumCodePoint) {
    return false;
  }
  return isInRange(wideRanges, codePoint);
};

// node_modules/get-east-asian-width/index.js
function validate(codePoint) {
  if (!Number.isSafeInteger(codePoint)) {
    throw new TypeError(`Expected a code point, got \`${typeof codePoint}\`.`);
  }
}
function eastAsianWidth(codePoint, { ambiguousAsWide = false } = {}) {
  validate(codePoint);
  if (isFullwidth(codePoint) || isWide(codePoint) || ambiguousAsWide && isAmbiguous(codePoint)) {
    return 2;
  }
  return 1;
}

// node_modules/emoji-regex/index.mjs
var emoji_regex_default = () => {
  return /[#*0-9]\uFE0F?\u20E3|[\xA9\xAE\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA\u231A\u231B\u2328\u23CF\u23ED-\u23EF\u23F1\u23F2\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB\u25FC\u25FE\u2600-\u2604\u260E\u2611\u2614\u2615\u2618\u2620\u2622\u2623\u2626\u262A\u262E\u262F\u2638-\u263A\u2640\u2642\u2648-\u2653\u265F\u2660\u2663\u2665\u2666\u2668\u267B\u267E\u267F\u2692\u2694-\u2697\u2699\u269B\u269C\u26A0\u26A7\u26AA\u26B0\u26B1\u26BD\u26BE\u26C4\u26C8\u26CF\u26D1\u26E9\u26F0-\u26F5\u26F7\u26F8\u26FA\u2702\u2708\u2709\u270F\u2712\u2714\u2716\u271D\u2721\u2733\u2734\u2744\u2747\u2757\u2763\u27A1\u2934\u2935\u2B05-\u2B07\u2B1B\u2B1C\u2B55\u3030\u303D\u3297\u3299]\uFE0F?|[\u261D\u270C\u270D](?:\uD83C[\uDFFB-\uDFFF]|\uFE0F)?|[\u270A\u270B](?:\uD83C[\uDFFB-\uDFFF])?|[\u23E9-\u23EC\u23F0\u23F3\u25FD\u2693\u26A1\u26AB\u26C5\u26CE\u26D4\u26EA\u26FD\u2705\u2728\u274C\u274E\u2753-\u2755\u2795-\u2797\u27B0\u27BF\u2B50]|\u26D3\uFE0F?(?:\u200D\uD83D\uDCA5)?|\u26F9(?:\uD83C[\uDFFB-\uDFFF]|\uFE0F)?(?:\u200D[\u2640\u2642]\uFE0F?)?|\u2764\uFE0F?(?:\u200D(?:\uD83D\uDD25|\uD83E\uDE79))?|\uD83C(?:[\uDC04\uDD70\uDD71\uDD7E\uDD7F\uDE02\uDE37\uDF21\uDF24-\uDF2C\uDF36\uDF7D\uDF96\uDF97\uDF99-\uDF9B\uDF9E\uDF9F\uDFCD\uDFCE\uDFD4-\uDFDF\uDFF5\uDFF7]\uFE0F?|[\uDF85\uDFC2\uDFC7](?:\uD83C[\uDFFB-\uDFFF])?|[\uDFC4\uDFCA](?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDFCB\uDFCC](?:\uD83C[\uDFFB-\uDFFF]|\uFE0F)?(?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDCCF\uDD8E\uDD91-\uDD9A\uDE01\uDE1A\uDE2F\uDE32-\uDE36\uDE38-\uDE3A\uDE50\uDE51\uDF00-\uDF20\uDF2D-\uDF35\uDF37-\uDF43\uDF45-\uDF4A\uDF4C-\uDF7C\uDF7E-\uDF84\uDF86-\uDF93\uDFA0-\uDFC1\uDFC5\uDFC6\uDFC8\uDFC9\uDFCF-\uDFD3\uDFE0-\uDFF0\uDFF8-\uDFFF]|\uDDE6\uD83C[\uDDE8-\uDDEC\uDDEE\uDDF1\uDDF2\uDDF4\uDDF6-\uDDFA\uDDFC\uDDFD\uDDFF]|\uDDE7\uD83C[\uDDE6\uDDE7\uDDE9-\uDDEF\uDDF1-\uDDF4\uDDF6-\uDDF9\uDDFB\uDDFC\uDDFE\uDDFF]|\uDDE8\uD83C[\uDDE6\uDDE8\uDDE9\uDDEB-\uDDEE\uDDF0-\uDDF7\uDDFA-\uDDFF]|\uDDE9\uD83C[\uDDEA\uDDEC\uDDEF\uDDF0\uDDF2\uDDF4\uDDFF]|\uDDEA\uD83C[\uDDE6\uDDE8\uDDEA\uDDEC\uDDED\uDDF7-\uDDFA]|\uDDEB\uD83C[\uDDEE-\uDDF0\uDDF2\uDDF4\uDDF7]|\uDDEC\uD83C[\uDDE6\uDDE7\uDDE9-\uDDEE\uDDF1-\uDDF3\uDDF5-\uDDFA\uDDFC\uDDFE]|\uDDED\uD83C[\uDDF0\uDDF2\uDDF3\uDDF7\uDDF9\uDDFA]|\uDDEE\uD83C[\uDDE8-\uDDEA\uDDF1-\uDDF4\uDDF6-\uDDF9]|\uDDEF\uD83C[\uDDEA\uDDF2\uDDF4\uDDF5]|\uDDF0\uD83C[\uDDEA\uDDEC-\uDDEE\uDDF2\uDDF3\uDDF5\uDDF7\uDDFC\uDDFE\uDDFF]|\uDDF1\uD83C[\uDDE6-\uDDE8\uDDEE\uDDF0\uDDF7-\uDDFB\uDDFE]|\uDDF2\uD83C[\uDDE6\uDDE8-\uDDED\uDDF0-\uDDFF]|\uDDF3\uD83C[\uDDE6\uDDE8\uDDEA-\uDDEC\uDDEE\uDDF1\uDDF4\uDDF5\uDDF7\uDDFA\uDDFF]|\uDDF4\uD83C\uDDF2|\uDDF5\uD83C[\uDDE6\uDDEA-\uDDED\uDDF0-\uDDF3\uDDF7-\uDDF9\uDDFC\uDDFE]|\uDDF6\uD83C\uDDE6|\uDDF7\uD83C[\uDDEA\uDDF4\uDDF8\uDDFA\uDDFC]|\uDDF8\uD83C[\uDDE6-\uDDEA\uDDEC-\uDDF4\uDDF7-\uDDF9\uDDFB\uDDFD-\uDDFF]|\uDDF9\uD83C[\uDDE6\uDDE8\uDDE9\uDDEB-\uDDED\uDDEF-\uDDF4\uDDF7\uDDF9\uDDFB\uDDFC\uDDFF]|\uDDFA\uD83C[\uDDE6\uDDEC\uDDF2\uDDF3\uDDF8\uDDFE\uDDFF]|\uDDFB\uD83C[\uDDE6\uDDE8\uDDEA\uDDEC\uDDEE\uDDF3\uDDFA]|\uDDFC\uD83C[\uDDEB\uDDF8]|\uDDFD\uD83C\uDDF0|\uDDFE\uD83C[\uDDEA\uDDF9]|\uDDFF\uD83C[\uDDE6\uDDF2\uDDFC]|\uDF44(?:\u200D\uD83D\uDFEB)?|\uDF4B(?:\u200D\uD83D\uDFE9)?|\uDFC3(?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D(?:[\u2640\u2642]\uFE0F?(?:\u200D\u27A1\uFE0F?)?|\u27A1\uFE0F?))?|\uDFF3\uFE0F?(?:\u200D(?:\u26A7\uFE0F?|\uD83C\uDF08))?|\uDFF4(?:\u200D\u2620\uFE0F?|\uDB40\uDC67\uDB40\uDC62\uDB40(?:\uDC65\uDB40\uDC6E\uDB40\uDC67|\uDC73\uDB40\uDC63\uDB40\uDC74|\uDC77\uDB40\uDC6C\uDB40\uDC73)\uDB40\uDC7F)?)|\uD83D(?:[\uDC3F\uDCFD\uDD49\uDD4A\uDD6F\uDD70\uDD73\uDD76-\uDD79\uDD87\uDD8A-\uDD8D\uDDA5\uDDA8\uDDB1\uDDB2\uDDBC\uDDC2-\uDDC4\uDDD1-\uDDD3\uDDDC-\uDDDE\uDDE1\uDDE3\uDDE8\uDDEF\uDDF3\uDDFA\uDECB\uDECD-\uDECF\uDEE0-\uDEE5\uDEE9\uDEF0\uDEF3]\uFE0F?|[\uDC42\uDC43\uDC46-\uDC50\uDC66\uDC67\uDC6B-\uDC6D\uDC72\uDC74-\uDC76\uDC78\uDC7C\uDC83\uDC85\uDC8F\uDC91\uDCAA\uDD7A\uDD95\uDD96\uDE4C\uDE4F\uDEC0\uDECC](?:\uD83C[\uDFFB-\uDFFF])?|[\uDC6E-\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4\uDEB5](?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDD74\uDD90](?:\uD83C[\uDFFB-\uDFFF]|\uFE0F)?|[\uDC00-\uDC07\uDC09-\uDC14\uDC16-\uDC25\uDC27-\uDC3A\uDC3C-\uDC3E\uDC40\uDC44\uDC45\uDC51-\uDC65\uDC6A\uDC79-\uDC7B\uDC7D-\uDC80\uDC84\uDC88-\uDC8E\uDC90\uDC92-\uDCA9\uDCAB-\uDCFC\uDCFF-\uDD3D\uDD4B-\uDD4E\uDD50-\uDD67\uDDA4\uDDFB-\uDE2D\uDE2F-\uDE34\uDE37-\uDE41\uDE43\uDE44\uDE48-\uDE4A\uDE80-\uDEA2\uDEA4-\uDEB3\uDEB7-\uDEBF\uDEC1-\uDEC5\uDED0-\uDED2\uDED5-\uDED8\uDEDC-\uDEDF\uDEEB\uDEEC\uDEF4-\uDEFC\uDFE0-\uDFEB\uDFF0]|\uDC08(?:\u200D\u2B1B)?|\uDC15(?:\u200D\uD83E\uDDBA)?|\uDC26(?:\u200D(?:\u2B1B|\uD83D\uDD25))?|\uDC3B(?:\u200D\u2744\uFE0F?)?|\uDC41\uFE0F?(?:\u200D\uD83D\uDDE8\uFE0F?)?|\uDC68(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDC68\uDC69]\u200D\uD83D(?:\uDC66(?:\u200D\uD83D\uDC66)?|\uDC67(?:\u200D\uD83D[\uDC66\uDC67])?)|[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC66(?:\u200D\uD83D\uDC66)?|\uDC67(?:\u200D\uD83D[\uDC66\uDC67])?)|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]))|\uD83C(?:\uDFFB(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83D\uDC68\uD83C[\uDFFC-\uDFFF])|\uD83E(?:[\uDD1D\uDEEF]\u200D\uD83D\uDC68\uD83C[\uDFFC-\uDFFF]|[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3])))?|\uDFFC(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83D\uDC68\uD83C[\uDFFB\uDFFD-\uDFFF])|\uD83E(?:[\uDD1D\uDEEF]\u200D\uD83D\uDC68\uD83C[\uDFFB\uDFFD-\uDFFF]|[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3])))?|\uDFFD(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83D\uDC68\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])|\uD83E(?:[\uDD1D\uDEEF]\u200D\uD83D\uDC68\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF]|[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3])))?|\uDFFE(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83D\uDC68\uD83C[\uDFFB-\uDFFD\uDFFF])|\uD83E(?:[\uDD1D\uDEEF]\u200D\uD83D\uDC68\uD83C[\uDFFB-\uDFFD\uDFFF]|[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3])))?|\uDFFF(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83D\uDC68\uD83C[\uDFFB-\uDFFE])|\uD83E(?:[\uDD1D\uDEEF]\u200D\uD83D\uDC68\uD83C[\uDFFB-\uDFFE]|[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3])))?))?|\uDC69(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?[\uDC68\uDC69]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC66(?:\u200D\uD83D\uDC66)?|\uDC67(?:\u200D\uD83D[\uDC66\uDC67])?|\uDC69\u200D\uD83D(?:\uDC66(?:\u200D\uD83D\uDC66)?|\uDC67(?:\u200D\uD83D[\uDC66\uDC67])?))|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]))|\uD83C(?:\uDFFB(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83D\uDC69\uD83C[\uDFFC-\uDFFF])|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFC-\uDFFF]|\uDEEF\u200D\uD83D\uDC69\uD83C[\uDFFC-\uDFFF])))?|\uDFFC(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83D\uDC69\uD83C[\uDFFB\uDFFD-\uDFFF])|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFB\uDFFD-\uDFFF]|\uDEEF\u200D\uD83D\uDC69\uD83C[\uDFFB\uDFFD-\uDFFF])))?|\uDFFD(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83D\uDC69\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF]|\uDEEF\u200D\uD83D\uDC69\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])))?|\uDFFE(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83D\uDC69\uD83C[\uDFFB-\uDFFD\uDFFF])|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFB-\uDFFD\uDFFF]|\uDEEF\u200D\uD83D\uDC69\uD83C[\uDFFB-\uDFFD\uDFFF])))?|\uDFFF(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83D\uDC69\uD83C[\uDFFB-\uDFFE])|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFB-\uDFFE]|\uDEEF\u200D\uD83D\uDC69\uD83C[\uDFFB-\uDFFE])))?))?|\uDD75(?:\uD83C[\uDFFB-\uDFFF]|\uFE0F)?(?:\u200D[\u2640\u2642]\uFE0F?)?|\uDE2E(?:\u200D\uD83D\uDCA8)?|\uDE35(?:\u200D\uD83D\uDCAB)?|\uDE36(?:\u200D\uD83C\uDF2B\uFE0F?)?|\uDE42(?:\u200D[\u2194\u2195]\uFE0F?)?|\uDEB6(?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D(?:[\u2640\u2642]\uFE0F?(?:\u200D\u27A1\uFE0F?)?|\u27A1\uFE0F?))?)|\uD83E(?:[\uDD0C\uDD0F\uDD18-\uDD1F\uDD30-\uDD34\uDD36\uDD77\uDDB5\uDDB6\uDDBB\uDDD2\uDDD3\uDDD5\uDEC3-\uDEC5\uDEF0\uDEF2-\uDEF8](?:\uD83C[\uDFFB-\uDFFF])?|[\uDD26\uDD35\uDD37-\uDD39\uDD3C-\uDD3E\uDDB8\uDDB9\uDDCD\uDDCF\uDDD4\uDDD6-\uDDDD](?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDDDE\uDDDF](?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDD0D\uDD0E\uDD10-\uDD17\uDD20-\uDD25\uDD27-\uDD2F\uDD3A\uDD3F-\uDD45\uDD47-\uDD76\uDD78-\uDDB4\uDDB7\uDDBA\uDDBC-\uDDCC\uDDD0\uDDE0-\uDDFF\uDE70-\uDE7C\uDE80-\uDE8A\uDE8E-\uDEC2\uDEC6\uDEC8\uDECD-\uDEDC\uDEDF-\uDEEA\uDEEF]|\uDDCE(?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D(?:[\u2640\u2642]\uFE0F?(?:\u200D\u27A1\uFE0F?)?|\u27A1\uFE0F?))?|\uDDD1(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3\uDE70]|\uDD1D\u200D\uD83E\uDDD1|\uDDD1\u200D\uD83E\uDDD2(?:\u200D\uD83E\uDDD2)?|\uDDD2(?:\u200D\uD83E\uDDD2)?))|\uD83C(?:\uDFFB(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFC-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83E\uDDD1\uD83C[\uDFFC-\uDFFF])|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3\uDE70]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF]|\uDEEF\u200D\uD83E\uDDD1\uD83C[\uDFFC-\uDFFF])))?|\uDFFC(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFB\uDFFD-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83E\uDDD1\uD83C[\uDFFB\uDFFD-\uDFFF])|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3\uDE70]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF]|\uDEEF\u200D\uD83E\uDDD1\uD83C[\uDFFB\uDFFD-\uDFFF])))?|\uDFFD(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83E\uDDD1\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3\uDE70]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF]|\uDEEF\u200D\uD83E\uDDD1\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])))?|\uDFFE(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFB-\uDFFD\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFD\uDFFF])|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3\uDE70]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF]|\uDEEF\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFD\uDFFF])))?|\uDFFF(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFB-\uDFFE]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFE])|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3\uDE70]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF]|\uDEEF\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFE])))?))?|\uDEF1(?:\uD83C(?:\uDFFB(?:\u200D\uD83E\uDEF2\uD83C[\uDFFC-\uDFFF])?|\uDFFC(?:\u200D\uD83E\uDEF2\uD83C[\uDFFB\uDFFD-\uDFFF])?|\uDFFD(?:\u200D\uD83E\uDEF2\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])?|\uDFFE(?:\u200D\uD83E\uDEF2\uD83C[\uDFFB-\uDFFD\uDFFF])?|\uDFFF(?:\u200D\uD83E\uDEF2\uD83C[\uDFFB-\uDFFE])?))?)/g;
};

// node_modules/string-width/index.js
var segmenter = new Intl.Segmenter;
var defaultIgnorableCodePointRegex = /^\p{Default_Ignorable_Code_Point}$/u;
function stringWidth(string, options = {}) {
  if (typeof string !== "string" || string.length === 0) {
    return 0;
  }
  const {
    ambiguousIsNarrow = true,
    countAnsiEscapeCodes = false
  } = options;
  if (!countAnsiEscapeCodes) {
    string = stripAnsi(string);
  }
  if (string.length === 0) {
    return 0;
  }
  let width = 0;
  const eastAsianWidthOptions = { ambiguousAsWide: !ambiguousIsNarrow };
  for (const { segment: character } of segmenter.segment(string)) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 31 || codePoint >= 127 && codePoint <= 159) {
      continue;
    }
    if (codePoint >= 8203 && codePoint <= 8207 || codePoint === 65279) {
      continue;
    }
    if (codePoint >= 768 && codePoint <= 879 || codePoint >= 6832 && codePoint <= 6911 || codePoint >= 7616 && codePoint <= 7679 || codePoint >= 8400 && codePoint <= 8447 || codePoint >= 65056 && codePoint <= 65071) {
      continue;
    }
    if (codePoint >= 55296 && codePoint <= 57343) {
      continue;
    }
    if (codePoint >= 65024 && codePoint <= 65039) {
      continue;
    }
    if (defaultIgnorableCodePointRegex.test(character)) {
      continue;
    }
    if (emoji_regex_default().test(character)) {
      width += 2;
      continue;
    }
    width += eastAsianWidth(codePoint, eastAsianWidthOptions);
  }
  return width;
}

// node_modules/@aeriondyseti/hook-kit/dist/index.js
function asString(body) {
  return typeof body === "string" ? body : body.render();
}
function hasHookSpecificFields(hs) {
  return Object.keys(hs).length > 1;
}
function mixinCommon(out, opts) {
  if (opts.toUser !== undefined)
    out.systemMessage = `
` + asString(opts.toUser);
  if (opts.continue !== undefined)
    out.continue = opts.continue;
  if (opts.stopReason !== undefined)
    out.stopReason = opts.stopReason;
  if (opts.suppressOutput !== undefined)
    out.suppressOutput = opts.suppressOutput;
  if (opts.terminalSequence !== undefined)
    out.terminalSequence = opts.terminalSequence;
  return out;
}
var ConfigChange = class {
  static parse() {
    return readHookInput("ConfigChange");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    if (opts.deny)
      out.decision = "block";
    if (opts.reason !== undefined)
      out.reason = opts.reason;
    return emitJson(out);
  }
};
var CwdChanged = class {
  static parse() {
    return readHookInput("CwdChanged");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    if (opts.watchPaths !== undefined) {
      out.hookSpecificOutput = { hookEventName: "CwdChanged", watchPaths: opts.watchPaths };
    }
    return emitJson(out);
  }
};
var DirectoryAdded = class {
  static parse() {
    return readHookInput("DirectoryAdded");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    return emitJson(out);
  }
};
var Elicitation = class {
  static parse() {
    return readHookInput("Elicitation");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    if (opts.reason !== undefined)
      out.reason = opts.reason;
    const hs = { hookEventName: "Elicitation" };
    if (opts.action !== undefined)
      hs.action = opts.action;
    if (opts.content !== undefined)
      hs.content = opts.content;
    if (hasHookSpecificFields(hs))
      out.hookSpecificOutput = hs;
    return emitJson(out);
  }
};
var ElicitationResult = class {
  static parse() {
    return readHookInput("ElicitationResult");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    if (opts.reason !== undefined)
      out.reason = opts.reason;
    const hs = { hookEventName: "ElicitationResult" };
    if (opts.action !== undefined)
      hs.action = opts.action;
    if (opts.content !== undefined)
      hs.content = opts.content;
    if (hasHookSpecificFields(hs))
      out.hookSpecificOutput = hs;
    return emitJson(out);
  }
};
var FileChanged = class {
  static parse() {
    return readHookInput("FileChanged");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    if (opts.watchPaths !== undefined) {
      out.hookSpecificOutput = { hookEventName: "FileChanged", watchPaths: opts.watchPaths };
    }
    return emitJson(out);
  }
};
var InstructionsLoaded = class {
  static parse() {
    return readHookInput("InstructionsLoaded");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    return emitJson(out);
  }
};
var MessageDisplay = class {
  static parse() {
    return readHookInput("MessageDisplay");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    if (opts.displayContent !== undefined) {
      out.hookSpecificOutput = { hookEventName: "MessageDisplay", displayContent: opts.displayContent };
    }
    return emitJson(out);
  }
};
var Notification = class {
  static parse() {
    return readHookInput("Notification");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    if (opts.toClaude !== undefined) {
      out.hookSpecificOutput = { hookEventName: "Notification", additionalContext: asString(opts.toClaude) };
    }
    return emitJson(out);
  }
};
var PermissionDenied = class {
  static parse() {
    return readHookInput("PermissionDenied");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    if (opts.retry !== undefined) {
      out.hookSpecificOutput = { hookEventName: "PermissionDenied", retry: opts.retry };
    }
    return emitJson(out);
  }
};
function toDecision(opts) {
  if (opts.decision === "allow") {
    const d = { behavior: "allow" };
    if (opts.updatedInput !== undefined)
      d.updatedInput = opts.updatedInput;
    if (opts.updatedPermissions !== undefined)
      d.updatedPermissions = opts.updatedPermissions;
    return d;
  }
  if (opts.decision === "deny") {
    const d = { behavior: "deny" };
    if (opts.reason !== undefined)
      d.message = opts.reason;
    if (opts.interrupt !== undefined)
      d.interrupt = opts.interrupt;
    return d;
  }
  return;
}
var PermissionRequest = class {
  static parse() {
    return readHookInput("PermissionRequest");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    const decision = toDecision(opts);
    if (decision)
      out.hookSpecificOutput = { hookEventName: "PermissionRequest", decision };
    return emitJson(out);
  }
};
var PostCompact = class {
  static parse() {
    return readHookInput("PostCompact");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    return emitJson(out);
  }
};
var PostModelSwitch = class {
  static parse() {
    return readHookInput("PostModelSwitch");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    if (opts.toClaude !== undefined) {
      out.hookSpecificOutput = { hookEventName: "PostModelSwitch", additionalContext: asString(opts.toClaude) };
    }
    return emitJson(out);
  }
};
var PostToolBatch = class {
  static parse() {
    return readHookInput("PostToolBatch");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    if (opts.toClaude !== undefined) {
      out.hookSpecificOutput = { hookEventName: "PostToolBatch", additionalContext: asString(opts.toClaude) };
    }
    return emitJson(out);
  }
};
var PostToolUse = class {
  static parse() {
    return readHookInput("PostToolUse");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    if (opts.deny)
      out.decision = "block";
    if (opts.reason !== undefined)
      out.reason = opts.reason;
    const hs = { hookEventName: "PostToolUse" };
    if (opts.toClaude !== undefined)
      hs.additionalContext = asString(opts.toClaude);
    if (opts.updatedToolOutput !== undefined)
      hs.updatedToolOutput = opts.updatedToolOutput;
    if (opts.updatedMCPToolOutput !== undefined)
      hs.updatedMCPToolOutput = opts.updatedMCPToolOutput;
    if (hasHookSpecificFields(hs))
      out.hookSpecificOutput = hs;
    return emitJson(out);
  }
};
var PostToolUseFailure = class {
  static parse() {
    return readHookInput("PostToolUseFailure");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    if (opts.toClaude !== undefined) {
      out.hookSpecificOutput = { hookEventName: "PostToolUseFailure", additionalContext: asString(opts.toClaude) };
    }
    return emitJson(out);
  }
};
var PreCompact = class {
  static parse() {
    return readHookInput("PreCompact");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    if (opts.deny)
      out.decision = "block";
    if (opts.reason !== undefined)
      out.reason = opts.reason;
    return emitJson(out);
  }
};
var PreModelSwitch = class {
  static parse() {
    return readHookInput("PreModelSwitch");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    const hs = { hookEventName: "PreModelSwitch" };
    if (opts.decision !== undefined)
      hs.permissionDecision = opts.decision;
    if (opts.reason !== undefined)
      hs.permissionDecisionReason = opts.reason;
    if (hasHookSpecificFields(hs))
      out.hookSpecificOutput = hs;
    return emitJson(out);
  }
};
var PreToolUse = class {
  static parse() {
    return readHookInput("PreToolUse");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    const hs = { hookEventName: "PreToolUse" };
    if (opts.decision !== undefined)
      hs.permissionDecision = opts.decision;
    if (opts.reason !== undefined)
      hs.permissionDecisionReason = opts.reason;
    if (opts.updatedInput !== undefined)
      hs.updatedInput = opts.updatedInput;
    if (opts.toClaude !== undefined)
      hs.additionalContext = asString(opts.toClaude);
    if (hasHookSpecificFields(hs))
      out.hookSpecificOutput = hs;
    return emitJson(out);
  }
};
var SessionEnd = class {
  static parse() {
    return readHookInput("SessionEnd");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    return emitJson(out);
  }
};
var SessionStart = class {
  static parse() {
    return readHookInput("SessionStart");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    const hs = { hookEventName: "SessionStart" };
    if (opts.toClaude !== undefined)
      hs.additionalContext = asString(opts.toClaude);
    if (opts.initialUserMessage !== undefined)
      hs.initialUserMessage = opts.initialUserMessage;
    if (opts.sessionTitle !== undefined)
      hs.sessionTitle = opts.sessionTitle;
    if (opts.watchPaths !== undefined)
      hs.watchPaths = opts.watchPaths;
    if (opts.reloadSkills !== undefined)
      hs.reloadSkills = opts.reloadSkills;
    if (hasHookSpecificFields(hs))
      out.hookSpecificOutput = hs;
    return emitJson(out);
  }
};
var Setup = class {
  static parse() {
    return readHookInput("Setup");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    if (opts.toClaude !== undefined) {
      out.hookSpecificOutput = { hookEventName: "Setup", additionalContext: asString(opts.toClaude) };
    }
    return emitJson(out);
  }
};
var Stop = class {
  static parse() {
    return readHookInput("Stop");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    if (opts.deny)
      out.decision = "block";
    if (opts.reason !== undefined)
      out.reason = opts.reason;
    if (opts.toClaude !== undefined) {
      out.hookSpecificOutput = { hookEventName: "Stop", additionalContext: asString(opts.toClaude) };
    }
    return emitJson(out);
  }
};
var StopFailure = class {
  static parse() {
    return readHookInput("StopFailure");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    return emitJson(out);
  }
};
var SubagentStart = class {
  static parse() {
    return readHookInput("SubagentStart");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    if (opts.toClaude !== undefined) {
      out.hookSpecificOutput = { hookEventName: "SubagentStart", additionalContext: asString(opts.toClaude) };
    }
    return emitJson(out);
  }
};
var SubagentStop = class {
  static parse() {
    return readHookInput("SubagentStop");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    if (opts.deny)
      out.decision = "block";
    if (opts.reason !== undefined)
      out.reason = opts.reason;
    if (opts.toClaude !== undefined) {
      out.hookSpecificOutput = { hookEventName: "SubagentStop", additionalContext: asString(opts.toClaude) };
    }
    return emitJson(out);
  }
};
var TaskCompleted = class {
  static parse() {
    return readHookInput("TaskCompleted");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    if (opts.deny)
      out.decision = "block";
    if (opts.reason !== undefined)
      out.reason = opts.reason;
    return emitJson(out);
  }
};
var TaskCreated = class {
  static parse() {
    return readHookInput("TaskCreated");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    if (opts.deny)
      out.decision = "block";
    if (opts.reason !== undefined)
      out.reason = opts.reason;
    return emitJson(out);
  }
};
var TeammateIdle = class {
  static parse() {
    return readHookInput("TeammateIdle");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    if (opts.deny)
      out.decision = "block";
    if (opts.reason !== undefined)
      out.reason = opts.reason;
    return emitJson(out);
  }
};
var UserPromptExpansion = class {
  static parse() {
    return readHookInput("UserPromptExpansion");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    if (opts.deny)
      out.decision = "block";
    if (opts.reason !== undefined)
      out.reason = opts.reason;
    const hs = { hookEventName: "UserPromptExpansion" };
    if (opts.toClaude !== undefined)
      hs.additionalContext = asString(opts.toClaude);
    if (opts.suppressOriginalPrompt !== undefined)
      hs.suppressOriginalPrompt = opts.suppressOriginalPrompt;
    if (hasHookSpecificFields(hs))
      out.hookSpecificOutput = hs;
    return emitJson(out);
  }
};
var UserPromptSubmit = class {
  static parse() {
    return readHookInput("UserPromptSubmit");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    if (opts.deny)
      out.decision = "block";
    if (opts.reason !== undefined)
      out.reason = opts.reason;
    const hs = { hookEventName: "UserPromptSubmit" };
    if (opts.toClaude !== undefined)
      hs.additionalContext = asString(opts.toClaude);
    if (opts.suppressOriginalPrompt !== undefined)
      hs.suppressOriginalPrompt = opts.suppressOriginalPrompt;
    if (opts.sessionTitle !== undefined)
      hs.sessionTitle = opts.sessionTitle;
    if (hasHookSpecificFields(hs))
      out.hookSpecificOutput = hs;
    return emitJson(out);
  }
};
var WorktreeCreate = class {
  static parse() {
    return readHookInput("WorktreeCreate");
  }
  static emitOutput(opts) {
    return emitText(opts.worktreePath);
  }
};
var WorktreeRemove = class {
  static parse() {
    return readHookInput("WorktreeRemove");
  }
  static emitOutput(opts = {}) {
    const out = mixinCommon({}, opts);
    return emitJson(out);
  }
};
var ICONS = {
  check: "\u2713",
  cross: "\u2717",
  warn: "\u26A0",
  info: "\u2139",
  arrow: "\u25B8",
  bullet: "\u2022",
  dot: "\xB7",
  star: "\u2605"
};
var _override;
function setTheme(override) {
  _override = override;
}
function currentTheme() {
  return {
    colors: _override?.colors ?? detectColors()
  };
}
function detectColors() {
  if (process.env.NO_COLOR)
    return false;
  if (process.env.FORCE_COLOR === "0")
    return false;
  return true;
}
var FG = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  grey: 90
};
var BG = Object.fromEntries(Object.entries(FG).map(([k, v]) => [k, v + 10]));
var MOD = { bold: 1, dim: 2, italic: 3, underline: 4 };
var MOD_CLOSE = { bold: 22, dim: 22, italic: 23, underline: 24 };
var ESC = "\x1B[";
var RESET = `${ESC}0m`;
var TAG_RE = /<(\/?)([a-z][a-z0-9_-]*)(?::"([^"]*)")?(\s*\/)?>/gi;
function renderTags(input, theme = currentTheme()) {
  if (!input.includes("<"))
    return input;
  if (!theme.colors)
    return stripTags(input);
  let emittedAnsi = false;
  const rendered = input.replace(TAG_RE, (full, slash, tagRaw, attr) => {
    const tag = tagRaw.toLowerCase();
    const code = slash ? closeCode(tag) : openCode(tag, attr);
    if (code === null)
      return full;
    emittedAnsi = true;
    return code;
  });
  return emittedAnsi ? rendered + RESET : rendered;
}
function openCode(tag, attr) {
  if (tag === "color" && attr) {
    const code = FG[attr.toLowerCase()];
    if (code !== undefined)
      return `${ESC}${code}m`;
  }
  if (tag === "bg" && attr) {
    const code = BG[attr.toLowerCase()];
    if (code !== undefined)
      return `${ESC}${code}m`;
  }
  const mod = MOD[tag];
  if (mod !== undefined)
    return `${ESC}${mod}m`;
  return null;
}
function closeCode(tag) {
  if (tag === "color")
    return `${ESC}39m`;
  if (tag === "bg")
    return `${ESC}49m`;
  const mod = MOD_CLOSE[tag];
  if (mod !== undefined)
    return `${ESC}${mod}m`;
  return null;
}
function stripTags(input) {
  if (!input.includes("<"))
    return input;
  return input.replace(TAG_RE, "");
}
function visualWidth(input) {
  return stringWidth(stripTags(input));
}
function detectWidth() {
  const env = Number(process.env.COLUMNS);
  if (Number.isFinite(env) && env > 20)
    return env;
  const stderrCols = process.stderr.columns;
  if (stderrCols !== undefined && stderrCols > 20)
    return stderrCols;
  return 80;
}
var OutputBuilder = class {
  content = "";
  append(text) {
    this.content += text;
    return this;
  }
  appendLine(text = "") {
    this.content += text + `
`;
    return this;
  }
  appendDivider(char = "-", opts = {}) {
    const cols = opts.width ?? detectWidth();
    const cellsPerCopy = visualWidth(char);
    const copies = cellsPerCopy > 0 ? Math.floor(cols / cellsPerCopy) : 0;
    const line = char.repeat(copies);
    return this.appendLine(opts.color ? `<color:"${opts.color}">${line}</color>` : line);
  }
  appendList(items, opts = {}) {
    const bullet = opts.bullet ?? ICONS.bullet;
    const pad = " ".repeat(opts.indent ?? 0);
    for (const item of items) {
      this.appendLine(`${pad}${bullet} ${item}`);
    }
    return this;
  }
  appendBox(content, opts = {}) {
    const padding = opts.padding ?? 1;
    const title = opts.title ?? "";
    const body = content.endsWith(`
`) ? content.slice(0, -1) : content;
    const lines = body.split(`
`);
    const contentWidth = Math.max(0, ...lines.map(visualWidth));
    const minForTitle = title ? visualWidth(title) + 3 - padding * 2 : 0;
    const inner = Math.max(contentWidth, minForTitle, 0);
    const totalWidth = inner + padding * 2;
    const hpad = " ".repeat(padding);
    const paint = (s) => opts.color ? `<color:"${opts.color}">${s}</color>` : s;
    const top = title ? paint(`\u250C\u2500 ${title} ${"\u2500".repeat(totalWidth - visualWidth(title) - 3)}\u2510`) : paint(`\u250C${"\u2500".repeat(totalWidth)}\u2510`);
    this.appendLine(top);
    for (const line of lines) {
      const rightPad = " ".repeat(inner - visualWidth(line));
      this.appendLine(`${paint("\u2502")}${hpad}${line}${rightPad}${hpad}${paint("\u2502")}`);
    }
    this.appendLine(paint(`\u2514${"\u2500".repeat(totalWidth)}\u2518`));
    return this;
  }
  appendTable(rows, opts = {}) {
    const { headers } = opts;
    const allRows = headers ? [headers, ...rows] : rows;
    if (allRows.length === 0)
      return this;
    const colCount = Math.max(0, ...allRows.map((r) => r.length));
    const widths = [];
    for (let c = 0;c < colCount; c++) {
      widths[c] = Math.max(0, ...allRows.map((r) => visualWidth(r[c] ?? "")));
    }
    const paint = (s) => opts.color ? `<color:"${opts.color}">${s}</color>` : s;
    const border = (l, m, r) => paint(l + widths.map((w) => "\u2500".repeat(w + 2)).join(m) + r);
    const padCell = (text, width) => text + " ".repeat(Math.max(0, width - visualWidth(text)));
    const renderRow = (cells) => {
      const bar = paint("\u2502");
      const body = widths.map((w, i) => ` ${padCell(cells[i] ?? "", w)} `).join(bar);
      return `${bar}${body}${bar}`;
    };
    this.appendLine(border("\u250C", "\u252C", "\u2510"));
    if (headers) {
      this.appendLine(renderRow(headers));
      this.appendLine(border("\u251C", "\u253C", "\u2524"));
    }
    for (const row of rows)
      this.appendLine(renderRow(row));
    this.appendLine(border("\u2514", "\u2534", "\u2518"));
    return this;
  }
  render(theme = currentTheme()) {
    return renderTags(this.content, theme);
  }
  toString() {
    return this.render();
  }
  get isEmpty() {
    return this.content === "";
  }
};
var COLORS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "gray",
  "grey"
];
var MODIFIERS = ["bold", "dim", "italic", "underline"];
function runHook(fn) {
  try {
    fn();
  } catch (e) {
    if (e instanceof HookParseError) {
      process.stderr.write(`${e.message}
`);
      process.exit(e.exitCode);
    }
    throw e;
  }
}
export {
  visualWidth,
  stripTags,
  setTheme,
  runHook,
  renderTags,
  currentTheme,
  WorktreeRemove,
  WorktreeCreate,
  UserPromptSubmit,
  UserPromptExpansion,
  TeammateIdle,
  TaskCreated,
  TaskCompleted,
  SubagentStop,
  SubagentStart,
  StopFailure,
  Stop,
  Setup,
  SessionStart,
  SessionEnd,
  PreToolUse,
  PreModelSwitch,
  PreCompact,
  PostToolUseFailure,
  PostToolUse,
  PostToolBatch,
  PostModelSwitch,
  PostCompact,
  PermissionRequest,
  PermissionDenied,
  OutputBuilder,
  Notification,
  MessageDisplay,
  MODIFIERS,
  InstructionsLoaded,
  ICONS,
  HookParseError,
  HOOK_EVENT_NAMES,
  FileChanged,
  ElicitationResult,
  Elicitation,
  DirectoryAdded,
  CwdChanged,
  ConfigChange,
  COLORS
};
