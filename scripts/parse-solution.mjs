/**
 * parse-solution.mjs  —  Universal Dataverse/Copilot Studio Solution Reverser
 *
 * Reads any exported solution ZIP and produces:
 *   power-platform/{solutionName}/solution.blueprint.json   ← if entities present
 *   power-platform/{solutionName}/agent.blueprint.json      ← if bot present
 *   power-platform/{solutionName}/flows/*.json              ← PA flows (always)
 *
 * Works on:
 *   - Pure Dataverse table solutions
 *   - Pure Copilot Studio agent solutions
 *   - Mixed solutions (tables + agent + flows)
 *   - Plain PA flow solutions (no tables, no bot)
 *
 * Usage:
 *   node scripts/parse-solution.mjs <path-to-solution.zip> [output-folder]
 */

import AdmZip from 'adm-zip';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';

// ══════════════════════════════════════════════════════════════════════════════
// XML / YAML helpers
// ══════════════════════════════════════════════════════════════════════════════

function xmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : null;
}
function xmlAttr(xml, tag, attr) {
  const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]+)"`));
  return m ? m[1] : null;
}
function xmlTagAll(xml, tag) {
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push({ attrs: m[1] || '', inner: m[2].trim() });
  return out;
}
function attrVal(attrsStr, attr) {
  const m = attrsStr.match(new RegExp(`\\s${attr}="([^"]+)"`));
  return m ? m[1] : null;
}

/** Extract a block scalar (|- or |) from a YAML string, indent-agnostic */
function extractBlockScalar(raw, key) {
  const norm = raw.replace(/\r\n/g, '\n');
  const startRe = new RegExp(`(?:^|\\n)[ \\t]*${key}:\\s*\\|-?\\n`);
  const startM = norm.match(startRe);
  if (!startM) return '';
  const start = startM.index + startM[0].length;
  const rest = norm.slice(start);
  const firstLine = rest.match(/^([ \t]+)/);
  if (!firstLine) return '';
  const indent = firstLine[1];
  const lines = [];
  for (const line of rest.split('\n')) {
    if (line.startsWith(indent)) lines.push(line.slice(indent.length));
    else if (line.trim() === '') lines.push('');
    else break;
  }
  return lines.join('\n').trimEnd();
}

const SYSTEM_TOPICS = new Set([
  'ConversationStart','EndofConversation','Escalate','Fallback',
  'Goodbye','Greeting','MultipleTopicsMatched','OnError',
  'ResetConversation','Search','Signin','StartOver','ThankYou',
]);

// XML type → blueprint type
const XML_TO_BLUEPRINT_TYPE = {
  nvarchar:   'SingleLine.Text',
  picklist:   'Choice',
  bit:        'TwoOptions',
  decimal:    'Decimal',
  int:        'WholeNumber',
  file:       'File',
  lookup:     'Lookup',
};

// ══════════════════════════════════════════════════════════════════════════════
// ZIP reader
// ══════════════════════════════════════════════════════════════════════════════

const [,, zipArg, outArg] = process.argv;
if (!zipArg) {
  console.error('Usage: node scripts/parse-solution.mjs <solution.zip> [output-folder]');
  process.exit(1);
}

const zipPath = path.resolve(zipArg);
if (!fs.existsSync(zipPath)) { console.error(`File not found: ${zipPath}`); process.exit(1); }

console.log(`\n📦 Reading ${path.basename(zipPath)} ...`);
const zip = new AdmZip(zipPath);

const entries = {};
for (const e of zip.getEntries()) {
  entries[e.entryName.replace(/\\/g, '/')] = e;
}

function read(p) {
  const e = entries[p];
  return e ? e.getData().toString('utf8') : null;
}
function readJson(p) {
  const raw = read(p);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. solution.xml — always present
// ══════════════════════════════════════════════════════════════════════════════

const solutionXml = read('solution.xml');
if (!solutionXml) { console.error('solution.xml not found'); process.exit(1); }

const solutionUniqueName = xmlTag(solutionXml, 'UniqueName');
const solutionVersion    = xmlTag(solutionXml, 'Version');
const solutionDisplay    = (() => {
  const m = solutionXml.match(/<SolutionManifest>[\s\S]*?<LocalizedName description="([^"]+)"/);
  return m ? m[1] : solutionUniqueName;
})();

const pubBlock = (() => {
  const m = solutionXml.match(/<Publisher>([\s\S]*?)<\/Publisher>/);
  return m ? m[1] : '';
})();
const publisher = {
  uniqueName:        xmlTag(pubBlock, 'UniqueName') || '',
  displayName:       (() => { const m = pubBlock.match(/<LocalizedName description="([^"]+)"/); return m?m[1]:''; })(),
  prefix:            xmlTag(pubBlock, 'CustomizationPrefix') || '',
  optionValuePrefix: parseInt(xmlTag(pubBlock, 'CustomizationOptionValuePrefix') || '10000'),
};

const rootComponents = [];
const rcRe = /<RootComponent type="(\d+)"[^>]*id="\{([^}]+)\}"[^>]*behavior="(\d+)"/g;
let rcM;
while ((rcM = rcRe.exec(solutionXml)) !== null)
  rootComponents.push({ type: parseInt(rcM[1]), id: rcM[2].toLowerCase(), behavior: parseInt(rcM[3]) });

console.log(`   Solution : ${solutionUniqueName} v${solutionVersion}`);
console.log(`   Publisher: ${publisher.prefix} (${publisher.uniqueName})`);

// ══════════════════════════════════════════════════════════════════════════════
// 2. customizations.xml — parse everything
// ══════════════════════════════════════════════════════════════════════════════

const customXml = read('customizations.xml') || '';

// ── 2a. Connection references ────────────────────────────────────────────────
const connectionReferences = [];
const crefRe = /<connectionreference connectionreferencelogicalname="([^"]+)">([\s\S]*?)<\/connectionreference>/g;
let crefM;
while ((crefM = crefRe.exec(customXml)) !== null) {
  const b = crefM[2];
  connectionReferences.push({
    logicalName:      crefM[1],
    displayName:      xmlTag(b,'connectionreferencedisplayname') || crefM[1],
    connectorId:      xmlTag(b,'connectorid') || '',
    isCustomizable:   parseInt(xmlTag(b,'iscustomizable') || '1'),
    promptingBehavior:parseInt(xmlTag(b,'promptingbehavior') || '0'),
  });
}

// ── 2b. Workflows (PA flows) ─────────────────────────────────────────────────
const flows = [];
const wfRe = /<Workflow WorkflowId="\{([^}]+)\}" Name="([^"]+)">([\s\S]*?)<\/Workflow>/g;
let wfM;
while ((wfM = wfRe.exec(customXml)) !== null) {
  const b = wfM[3];
  const langM = b.match(/<LocalizedName languagecode="(\d+)"\s+description="([^"]+)"/);
  flows.push({
    name:                wfM[2],
    guid:                wfM[1].toLowerCase(),
    jsonFile:            (xmlTag(b,'JsonFileName') || '').replace(/^\//, ''),
    languageCode:        langM ? parseInt(langM[1]) : 1033,
    languageDescription: langM ? langM[2] : wfM[2],
    stateCode:           parseInt(xmlTag(b,'StateCode') || '1'),
  });
}

// ── 2c. AI Models ────────────────────────────────────────────────────────────
const aiModels = [];
const aiRe = /<AIModel>([\s\S]*?)<\/AIModel>/g;
let aiM;
while ((aiM = aiRe.exec(customXml)) !== null) {
  const b = aiM[1];
  aiModels.push({
    id:         (xmlTag(b,'msdyn_aimodelid') || '').replace(/[{}]/g,'').toLowerCase(),
    name:       xmlTag(b,'msdyn_name') || '',
    templateId: (xmlTag(b,'msdyn_templateid') || '').replace(/[{}]/g,'').toLowerCase(),
  });
}

// ── 2d. Language ─────────────────────────────────────────────────────────────
const languageCode = (() => {
  const m = customXml.match(/<Language>(\d+)<\/Language>/);
  return m ? parseInt(m[1]) : 1033;
})();

// ── 2e. Entities (Dataverse tables) ──────────────────────────────────────────
const entitiesBlock = (() => {
  const m = customXml.match(/<Entities>([\s\S]*?)<\/Entities>/);
  return m ? m[1] : '';
})();

// EntityRelationships global section
const entityRelBlock = (() => {
  const m = customXml.match(/<EntityRelationships>([\s\S]*?)<\/EntityRelationships>/);
  return m ? m[1] : '';
})();

// Parse global EntityRelationship blocks
const relationships = [];
const erRe = /<EntityRelationship Name="([^"]+)">([\s\S]*?)<\/EntityRelationship>/g;
let erM;
while ((erM = erRe.exec(entityRelBlock)) !== null) {
  const name = erM[1];
  const b    = erM[2];
  const cascadeDelete  = xmlTag(b,'CascadeDelete') || 'NoCascade';
  const cascadeAssign  = xmlTag(b,'CascadeAssign') || 'NoCascade';
  const behavior = (cascadeDelete === 'Cascade' && cascadeAssign === 'Cascade') ? 'Parental' : 'Referential';
  relationships.push({
    schemaName:              name,
    referencingEntity:       xmlTag(b,'ReferencingEntityName') || '',
    referencedEntity:        xmlTag(b,'ReferencedEntityName')  || '',
    referencingAttribute:    xmlTag(b,'ReferencingAttributeName') || '',
    behavior,
  });
}

// Parse entity blocks
const tables = [];
const entityRe = /<Entity xmlns:xsi[^>]*>([\s\S]*?)<\/Entity>/g;
let entityM;
while ((entityM = entityRe.exec(entitiesBlock)) !== null) {
  const entityContent = entityM[1];

  // Schema name from <Name LocalizedName="..." OriginalName="...">schemaName</Name>
  const nameTag = entityContent.match(/<Name[^>]*>([^<]+)<\/Name>/);
  const schemaName = nameTag ? nameTag[1].trim() : null;
  if (!schemaName) continue;

  const logicalName = schemaName.toLowerCase();

  // Display/plural names from EntityInfo
  const entityInfoBlock = (() => {
    const m = entityContent.match(/<EntityInfo>([\s\S]*?)<\/EntityInfo>/);
    return m ? m[1] : '';
  })();
  const innerEntityBlock = (() => {
    const m = entityInfoBlock.match(/<entity[^>]*>([\s\S]*?)<\/entity>/);
    return m ? m[1] : '';
  })();

  const displayName = (() => {
    const m = innerEntityBlock.match(/<LocalizedNames>[\s\S]*?<LocalizedName description="([^"]+)"/);
    return m ? m[1] : schemaName;
  })();
  const pluralDisplayName = (() => {
    const m = innerEntityBlock.match(/<LocalizedCollectionNames>[\s\S]*?<LocalizedCollectionName description="([^"]+)"/);
    return m ? m[1] : displayName + 's';
  })();

  // Attributes
  const attrsBlock = (() => {
    const m = innerEntityBlock.match(/<attributes>([\s\S]*?)<\/attributes>/);
    return m ? m[1] : '';
  })();

  const columns = [];
  const attrRe = /<attribute PhysicalName="([^"]+)">([\s\S]*?)<\/attribute>/g;
  let attrM;
  while ((attrM = attrRe.exec(attrsBlock)) !== null) {
    const physName = attrM[1];
    const b        = attrM[2];

    const xmlType     = xmlTag(b, 'Type') || '';
    const attrLogical = xmlTag(b, 'LogicalName') || xmlTag(b, 'Name') || physName.toLowerCase();
    const reqLevel    = xmlTag(b, 'RequiredLevel') || 'none';
    const displayMask = xmlTag(b, 'DisplayMask') || '';

    // Skip primary key and system attributes
    if (xmlType === 'primarykey') continue;
    if (xmlType === 'state' || xmlType === 'status' || xmlType === 'owner' || xmlType === 'customer') continue;
    if (xmlType === 'lookup' && displayMask.includes('ValidForAdvancedFind') === false && !attrLogical.startsWith(publisher.prefix)) continue;

    const attrDisplayName = (() => {
      const m = b.match(/<displaynames>[\s\S]*?<displayname description="([^"]+)"/);
      return m ? m[1] : physName;
    })();

    const col = {
      schemaName:   physName,
      logicalName:  attrLogical,
      displayName:  attrDisplayName,
      required:     reqLevel === 'required' || reqLevel === 'systemrequired',
    };

    // isPrimaryName
    if (displayMask.includes('PrimaryName')) col.isPrimaryName = true;

    switch (xmlType) {
      case 'nvarchar': {
        const format    = (xmlTag(b,'Format') || 'text').toLowerCase();
        const maxLength = parseInt(xmlTag(b,'MaxLength') || '100');
        col.type      = format === 'text' && maxLength > 2000 ? 'MultipleLines.Text' : 'SingleLine.Text';
        col.maxLength = maxLength;
        break;
      }
      case 'picklist': {
        col.type = 'Choice';
        const osBlock = (() => {
          const m = b.match(/<optionset[^>]*>([\s\S]*?)<\/optionset>/);
          return m ? m[1] : '';
        })();
        const osNameM = b.match(/<optionset Name="([^"]+)"/);
        col.choiceName = osNameM ? osNameM[1] : '';
        col.choices = [];
        const optRe = /<option value="(-?\d+)"[^>]*>([\s\S]*?)<\/option>/g;
        let optM;
        while ((optM = optRe.exec(osBlock)) !== null) {
          const labelM = optM[2].match(/<label description="([^"]+)"/);
          col.choices.push({ value: parseInt(optM[1]), label: labelM ? labelM[1] : '' });
        }
        break;
      }
      case 'bit': {
        col.type = 'TwoOptions';
        const osBlock = (() => {
          const m = b.match(/<optionset[^>]*>([\s\S]*?)<\/optionset>/);
          return m ? m[1] : '';
        })();
        col.choices = [];
        const optRe = /<option value="([01])"[^>]*>([\s\S]*?)<\/option>/g;
        let optM;
        while ((optM = optRe.exec(osBlock)) !== null) {
          const labelM = optM[2].match(/<label description="([^"]+)"/);
          col.choices.push({ value: parseInt(optM[1]), label: labelM ? labelM[1] : '' });
        }
        break;
      }
      case 'datetime': {
        const behavior = parseInt(xmlTag(b,'Behavior') || '1');
        col.type = behavior === 2 ? 'DateOnly' : 'DateTime';
        break;
      }
      case 'decimal': {
        col.type      = 'Decimal';
        col.precision = parseInt(xmlTag(b,'Precision') || '2');
        col.minValue  = xmlTag(b,'MinValue');
        col.maxValue  = xmlTag(b,'MaxValue');
        break;
      }
      case 'int': {
        col.type     = 'WholeNumber';
        col.minValue = xmlTag(b,'MinValue');
        col.maxValue = xmlTag(b,'MaxValue');
        break;
      }
      case 'file': {
        col.type         = 'File';
        col.maxSizeInKB  = parseInt(xmlTag(b,'MaxValue') || '32768');
        break;
      }
      case 'lookup': {
        col.type = 'Lookup';
        // Target resolved from relationships below
        break;
      }
      default:
        col.type = xmlType;
    }

    columns.push(col);
  }

  // Attach relationship info to Lookup columns
  const tableRels = relationships
    .filter(r => r.referencingEntity.toLowerCase() === logicalName)
    .map(r => {
      const matchingCol = columns.find(c => c.logicalName === r.referencingAttribute.toLowerCase());
      return {
        schemaName:  r.schemaName,
        column:      r.referencingAttribute.toLowerCase(),
        targetTable: r.referencedEntity.toLowerCase(),
        behavior:    r.behavior,
        displayName: matchingCol?.displayName,
      };
    });

  // Remove Lookup columns from columns (they appear in relationships)
  const nonLookupColumns = columns.filter(c => c.type !== 'Lookup');

  tables.push({
    logicalName,
    schemaName,
    displayName,
    pluralDisplayName,
    columns: nonLookupColumns,
    relationships: tableRels,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. Bot / Copilot Studio components (optional)
// ══════════════════════════════════════════════════════════════════════════════

const botFolder = Object.keys(entries).find(k => k.startsWith('bots/') && k.endsWith('/bot.xml'));
let agentBlueprint = null;

if (botFolder) {
  const botSchemaName = botFolder.split('/')[1];
  console.log(`   Bot      : ${botSchemaName}`);

  // bot.xml
  const botXml        = read(`bots/${botSchemaName}/bot.xml`) || '';
  const botAuthMode   = parseInt(xmlTag(botXml,'authenticationmode') || '2');
  const botAuthTrigger= parseInt(xmlTag(botXml,'authenticationtrigger') || '1');

  // configuration.json
  const config        = readJson(`bots/${botSchemaName}/configuration.json`) || {};
  const channels      = (config.channels || []).map(c => c.channelId);

  // GPT default
  const gptData = read(`botcomponents/${botSchemaName}.gpt.default/data`) || '';
  const orchestrator = {
    displayName:  (gptData.match(/displayName:\s*(.+)/) || [])[1]?.trim() || solutionDisplay,
    instructions: extractBlockScalar(gptData, 'instructions'),
    model:        (gptData.match(/modelNameHint:\s*(.+)/) || [])[1]?.trim() || 'GPT5Chat',
    webBrowsing:  (gptData.match(/webBrowsing:\s*(.+)/) || [])[1]?.trim() === 'true',
  };

  // Sub-agents
  const subAgents = [];
  for (const ep of Object.keys(entries).filter(k =>
      k.startsWith(`botcomponents/${botSchemaName}.agent.`) && k.endsWith('/data'))) {
    const localName = ep.replace(`botcomponents/${botSchemaName}.agent.`,'').replace('/data','');
    const raw = read(ep) || '';
    const descM = raw.match(/description:\s*(.+)/);
    subAgents.push({
      localName,
      description:              (descM?.[1] || '').trim(),
      instructions:             extractBlockScalar(raw, 'instructions'),
      declarativeSkillsMetadata: raw.includes('declarativeSkillsMetadata'),
    });
  }

  // Actions
  const actions = [];
  for (const ep of Object.keys(entries).filter(k =>
      k.startsWith(`botcomponents/${botSchemaName}.action.`) && k.endsWith('/data'))) {
    const localName = ep.replace(`botcomponents/${botSchemaName}.action.`,'').replace('/data','');
    const raw = read(ep) || '';
    let parsed; try { parsed = yaml.load(raw); } catch { continue; }
    if (!parsed) continue;
    const action = parsed.action || {};
    const kind   = action.kind === 'InvokeFlowTaskAction' ? 'flow' : 'connector';
    const entry  = {
      localName,
      kind,
      modelDisplayName: parsed.modelDisplayName || localName,
      modelDescription: parsed.modelDescription || '',
      inputs:  (parsed.inputs  || []).map(i => ({ kind: i.kind==='ManualTaskInput'?'manual':'automatic', propertyName: i.propertyName, ...(i.value!==undefined?{value:i.value}:{}) })),
      outputs: (parsed.outputs || []).map(o => ({ propertyName: o.propertyName, ...(o.name?{name:o.name}:{}), ...(o.description?{description:o.description}:{}) })),
      outputMode:     parsed.outputMode || 'All',
      connectionMode: action.connectionProperties?.mode || 'Invoker',
    };
    if (kind === 'flow')      entry.flowId            = action.flowId || '';
    else { entry.connectionReference = action.connectionReference || ''; entry.operationId = action.operationId || ''; if (action.dynamicOutputSchema) entry.dynamicOutputSchema = action.dynamicOutputSchema; }
    actions.push(entry);
  }

  // Topics
  const topics = [];
  for (const ep of Object.keys(entries).filter(k =>
      k.startsWith(`botcomponents/${botSchemaName}.topic.`) && k.endsWith('/data'))) {
    const localName = ep.replace(`botcomponents/${botSchemaName}.topic.`,'').replace('/data','');
    const raw = read(ep) || '';
    const kindM = raw.match(/kind:\s*(On\w+)/);
    const descM = raw.match(/modelDescription:\s*(.+)/);
    const topic = {
      localName,
      isSystem:         SYSTEM_TOPICS.has(localName),
      triggerKind:      kindM?.[1] || 'Unknown',
      modelDescription: (descM?.[1] || '').trim(),
      content:          raw.trimEnd(),
    };
    // AI model ref
    const aiModelKey = `${botSchemaName}.topic.${localName}`;
    const aiModelSetXml = read('Assets/botcomponent_msdyn_aimodelset.xml') || '';
    const aiIdM = aiModelSetXml.match(new RegExp(`botcomponentid\\.schemaname="${aiModelKey.replace(/\./g,'\\.')}"\\s+msdyn_aimodelid\\.msdyn_aimodelid="([^"]+)"`));
    if (aiIdM) topic.aiModelId = aiIdM[1].toLowerCase();
    topics.push(topic);
  }

  // Assets — enrich actions
  const workflowSetXml = read('Assets/botcomponent_workflowset.xml') || '';
  const connRefSetXml  = read('Assets/botcomponent_connectionreferenceset.xml') || '';
  for (const action of actions) {
    const sn = `${botSchemaName}.action.${action.localName}`;
    if (action.kind === 'flow') {
      const wm = workflowSetXml.match(new RegExp(`botcomponentid\\.schemaname="${sn.replace(/\./g,'\\.')}\"\\s+workflowid\\.workflowid="([^"]+)"`));
      if (wm) action.flowId = wm[1].toLowerCase();
    } else {
      const cm = connRefSetXml.match(new RegExp(`botcomponentid\\.schemaname="${sn.replace(/\./g,'\\.')}\"\\s+connectionreferenceid\\.connectionreferencelogicalname="([^"]+)"`));
      if (cm) action.connectionReference = cm[1];
    }
  }

  agentBlueprint = {
    _comment: 'Auto-generated by parse-solution.mjs. Edit and re-run generate-agent-solution.mjs to rebuild.',
    solution: { uniqueName: solutionUniqueName, displayName: solutionDisplay, version: solutionVersion, languageCode },
    publisher,
    bot: {
      schemaName:           botSchemaName,
      authenticationMode:   botAuthMode,
      authenticationTrigger: botAuthTrigger,
      channels,
      settings:             config.settings || {},
      isAgentConnectable:   config.isAgentConnectable ?? true,
      publishOnImport:      config.publishOnImport    ?? true,
      isLightweightBot:     config.isLightweightBot   ?? false,
      recognizer:           config.recognizer?.$kind?.replace('Recognizer','') || 'GenerativeAI',
      aiSettings:           config.aISettings || {},
    },
    orchestrator,
    subAgents,
    actions,
    topics,
    flows,
    connectionReferences,
    aiModels,
    rootComponents,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. Dataverse solution blueprint (tables)
// ══════════════════════════════════════════════════════════════════════════════

let dataverseBlueprint = null;
if (tables.length > 0) {
  dataverseBlueprint = {
    _comment: 'Auto-generated by parse-solution.mjs. Edit and re-run generate-solution.mjs to rebuild.',
    solution: { uniqueName: solutionUniqueName, displayName: solutionDisplay, version: solutionVersion },
    ...(flows.length > 0 && !agentBlueprint ? { flows } : {}),
    ...(connectionReferences.length > 0 && !agentBlueprint ? { connectionReferences } : {}),
  };
}

// Plain flow-only solution (no tables, no bot)
let flowBlueprint = null;
if (!agentBlueprint && !dataverseBlueprint && flows.length > 0) {
  flowBlueprint = {
    _comment: 'Auto-generated by parse-solution.mjs.',
    solution: { uniqueName: solutionUniqueName, displayName: solutionDisplay, version: solutionVersion },
    publisher,
    flows,
    connectionReferences,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. Write output
// ══════════════════════════════════════════════════════════════════════════════

const outputBase = path.resolve(outArg || path.join('power-platform', solutionUniqueName));
fs.mkdirSync(outputBase, { recursive: true });
fs.mkdirSync(path.join(outputBase, 'flows'), { recursive: true });

const written = [];

if (agentBlueprint) {
  const p = path.join(outputBase, 'agent.blueprint.json');
  fs.writeFileSync(p, JSON.stringify(agentBlueprint, null, 2), 'utf8');
  written.push('agent.blueprint.json');
}
if (dataverseBlueprint) {
  const p = path.join(outputBase, 'solution.blueprint.json');
  fs.writeFileSync(p, JSON.stringify(dataverseBlueprint, null, 2), 'utf8');
  written.push('solution.blueprint.json');
}
if (flowBlueprint) {
  const p = path.join(outputBase, 'flow.blueprint.json');
  fs.writeFileSync(p, JSON.stringify(flowBlueprint, null, 2), 'utf8');
  written.push('flow.blueprint.json');
}

// Copy flow JSONs
let flowCount = 0;
for (const flow of flows) {
  const ep = flow.jsonFile.replace(/\\/g,'/');
  const raw = read(ep);
  if (raw) {
    fs.writeFileSync(path.join(outputBase, 'flows', path.basename(ep)), raw, 'utf8');
    flowCount++;
  }
}

// Save raw ZIP files for agent solutions (enables generator to reconstruct ZIP)
let rawCount = 0;
if (agentBlueprint) {
  const rawDir = path.join(outputBase, 'raw');
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const entryName = entry.entryName.replace(/\\/g, '/');
    const dest = path.join(rawDir, entryName);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
    rawCount++;
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n✅ Done → ${outputBase}`);
const kinds = [
  agentBlueprint     && `agent (${agentBlueprint.subAgents?.length??0} sub-agents, ${agentBlueprint.actions?.length??0} actions, ${agentBlueprint.topics?.length??0} topics)`,
  dataverseBlueprint && `dataverse (${tables.length} tables)`,
  flowBlueprint      && `flow-only`,
].filter(Boolean);
console.log(`   Type    : ${kinds.join(' + ') || 'unknown'}`);
written.forEach(f => console.log(`   📄 ${f}`));
if (flowCount) console.log(`   📁 flows/ (${flowCount} file${flowCount!==1?'s':''})`);
if (rawCount)  console.log(`   📁 raw/   (${rawCount} file${rawCount!==1?'s':''} — full ZIP structure preserved)`);
