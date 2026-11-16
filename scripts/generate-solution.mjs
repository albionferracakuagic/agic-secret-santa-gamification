/**
 * generate-solution.mjs
 * Generates a deployable Power Platform solution ZIP from a blueprint JSON.
 * Supports:
 *   - solution.blueprint.json  → Dataverse tables solution
 *   - agent.blueprint.json     → Copilot Studio agent solution (raw/ strategy)
 *   - flow.blueprint.json      → Power Automate flow solution
 *
 * Usage:
 *   node scripts/generate-solution.mjs
 *       → auto-discovers all *.blueprint.json under power-platform/ and builds each
 *
 *   node scripts/generate-solution.mjs --blueprint <path> [--output <dir>]
 *       → builds a single blueprint; output defaults to <blueprintDir>/dist
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import AdmZip from 'adm-zip';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** XML-escape a string */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convert a logical name to a PhysicalName for attribute elements.
 * {prefix}_datavisita → {prefix}_Datavisita, {prefix}_nucleofamiliare → {prefix}_Nucleofamiliare
 */
function toPhysicalName(logicalName, schemaName) {
  if (schemaName) return schemaName; // use explicit schemaName from blueprint if provided
  const m = logicalName.match(/^([a-z]+_)(.+)$/);
  if (m) return m[1] + m[2][0].toUpperCase() + m[2].slice(1);
  return logicalName;
}

/** Shared flags block. PK uses isCustomField=0, isAuditEnabled=0 */
function sharedFlagsXml(isCustomField = 1, isAuditEnabled = 1, indent = '        ') {
  return `${indent}<IsCustomField>${isCustomField}</IsCustomField>
${indent}<IsAuditEnabled>${isAuditEnabled}</IsAuditEnabled>
${indent}<IsSecured>0</IsSecured>
${indent}<IntroducedVersion>1.0.0.0</IntroducedVersion>
${indent}<IsCustomizable>1</IsCustomizable>
${indent}<IsRenameable>1</IsRenameable>
${indent}<CanModifySearchSettings>1</CanModifySearchSettings>
${indent}<CanModifyRequirementLevelSettings>1</CanModifyRequirementLevelSettings>
${indent}<CanModifyAdditionalSettings>1</CanModifyAdditionalSettings>
${indent}<SourceType>0</SourceType>
${indent}<IsGlobalFilterEnabled>0</IsGlobalFilterEnabled>
${indent}<IsSortableEnabled>0</IsSortableEnabled>
${indent}<CanModifyGlobalFilterSettings>1</CanModifyGlobalFilterSettings>
${indent}<CanModifyIsSortableSettings>1</CanModifyIsSortableSettings>
${indent}<IsDataSourceSecret>0</IsDataSourceSecret>
${indent}<AutoNumberFormat></AutoNumberFormat>`;
}

/** displaynames + Descriptions block */
function displayBlock(description, indent = '        ') {
  return `${indent}<displaynames>
${indent}  <displayname description="${esc(description)}" languagecode="1033" />
${indent}</displaynames>
${indent}<Descriptions>
${indent}  <Description description="" languagecode="1033" />
${indent}</Descriptions>`;
}

// ─── Attribute generators ────────────────────────────────────────────────────

function pkAttributeXml(table, indent = '      ') {
  const physName = table.schemaName + 'Id';
  const logName  = table.logicalName + 'id';
  return `${indent}<attribute PhysicalName="${physName}">
${indent}  <Type>primarykey</Type>
${indent}  <Name>${logName}</Name>
${indent}  <LogicalName>${logName}</LogicalName>
${indent}  <RequiredLevel>systemrequired</RequiredLevel>
${indent}  <DisplayMask>ValidForAdvancedFind|RequiredForGrid</DisplayMask>
${indent}  <ImeMode>auto</ImeMode>
${indent}  <ValidForUpdateApi>0</ValidForUpdateApi>
${indent}  <ValidForReadApi>1</ValidForReadApi>
${indent}  <ValidForCreateApi>1</ValidForCreateApi>
${sharedFlagsXml(0, 0, indent + '  ')}
${indent}  <IsSearchable>0</IsSearchable>
${indent}  <IsFilterable>1</IsFilterable>
${indent}  <IsRetrievable>1</IsRetrievable>
${indent}  <IsLocalizable>0</IsLocalizable>
${displayBlock(table.displayName + ' ID', indent + '  ')}
${indent}</attribute>`;
}

function nameAttributeXml(col, indent = '      ') {
  return `${indent}<attribute PhysicalName="${col.schemaName}">
${indent}  <Type>nvarchar</Type>
${indent}  <Name>${col.logicalName}</Name>
${indent}  <LogicalName>${col.logicalName}</LogicalName>
${indent}  <RequiredLevel>none</RequiredLevel>
${indent}  <DisplayMask>PrimaryName|ValidForForm|ValidForGrid|RequiredForForm</DisplayMask>
${indent}  <ImeMode>auto</ImeMode>
${indent}  <ValidForUpdateApi>1</ValidForUpdateApi>
${indent}  <ValidForReadApi>1</ValidForReadApi>
${indent}  <ValidForCreateApi>1</ValidForCreateApi>
${sharedFlagsXml(1, 1, indent + '  ')}
${indent}  <IsSearchable>1</IsSearchable>
${indent}  <IsFilterable>0</IsFilterable>
${indent}  <IsRetrievable>1</IsRetrievable>
${indent}  <IsLocalizable>0</IsLocalizable>
${indent}  <Format>text</Format>
${indent}  <MaxLength>${col.maxLength}</MaxLength>
${indent}  <Length>${col.maxLength * 2}</Length>
${displayBlock(col.displayName, indent + '  ')}
${indent}</attribute>`;
}

function lookupAttributeXml(logicalName, displayName, indent = '      ') {
  const physName = toPhysicalName(logicalName);
  return `${indent}<attribute PhysicalName="${physName}">
${indent}  <Type>lookup</Type>
${indent}  <Name>${logicalName}</Name>
${indent}  <LogicalName>${logicalName}</LogicalName>
${indent}  <RequiredLevel>none</RequiredLevel>
${indent}  <DisplayMask>ValidForAdvancedFind|ValidForForm|ValidForGrid</DisplayMask>
${indent}  <ValidForUpdateApi>1</ValidForUpdateApi>
${indent}  <ValidForReadApi>1</ValidForReadApi>
${indent}  <ValidForCreateApi>1</ValidForCreateApi>
${sharedFlagsXml(1, 1, indent + '  ')}
${indent}  <IsSearchable>0</IsSearchable>
${indent}  <IsFilterable>0</IsFilterable>
${indent}  <IsRetrievable>0</IsRetrievable>
${indent}  <IsLocalizable>0</IsLocalizable>
${indent}  <LookupStyle>single</LookupStyle>
${indent}  <LookupTypes />
${displayBlock(displayName, indent + '  ')}
${indent}</attribute>`;
}

// ─── Entity metadata block (after </attributes>) ─────────────────────────────

function entityMetadataXml(logicalName, indent = '      ') {
  return `${indent}<EntitySetName>${logicalName}s</EntitySetName>
${indent}<IsDuplicateCheckSupported>0</IsDuplicateCheckSupported>
${indent}<IsBusinessProcessEnabled>0</IsBusinessProcessEnabled>
${indent}<IsRequiredOffline>0</IsRequiredOffline>
${indent}<IsInteractionCentricEnabled>0</IsInteractionCentricEnabled>
${indent}<IsCollaboration>0</IsCollaboration>
${indent}<AutoRouteToOwnerQueue>0</AutoRouteToOwnerQueue>
${indent}<IsConnectionsEnabled>0</IsConnectionsEnabled>
${indent}<EntityColor></EntityColor>
${indent}<IsDocumentManagementEnabled>0</IsDocumentManagementEnabled>
${indent}<AutoCreateAccessTeams>0</AutoCreateAccessTeams>
${indent}<IsOneNoteIntegrationEnabled>0</IsOneNoteIntegrationEnabled>
${indent}<IsKnowledgeManagementEnabled>0</IsKnowledgeManagementEnabled>
${indent}<IsSLAEnabled>0</IsSLAEnabled>
${indent}<IsDocumentRecommendationsEnabled>0</IsDocumentRecommendationsEnabled>
${indent}<IsBPFEntity>0</IsBPFEntity>
${indent}<OwnershipTypeMask>UserOwned</OwnershipTypeMask>
${indent}<IsAuditEnabled>1</IsAuditEnabled>
${indent}<IsActivity>0</IsActivity>
${indent}<ActivityTypeMask></ActivityTypeMask>
${indent}<IsActivityParty>0</IsActivityParty>
${indent}<IsMailMergeEnabled>0</IsMailMergeEnabled>
${indent}<IsVisibleInMobile>0</IsVisibleInMobile>
${indent}<IsVisibleInMobileClient>1</IsVisibleInMobileClient>
${indent}<IsReadOnlyInMobileClient>0</IsReadOnlyInMobileClient>
${indent}<IsOfflineInMobileClient>1</IsOfflineInMobileClient>
${indent}<DaysSinceRecordLastModified>0</DaysSinceRecordLastModified>
${indent}<IsMapiGridEnabled>1</IsMapiGridEnabled>
${indent}<IsReadingPaneEnabled>1</IsReadingPaneEnabled>
${indent}<IsQuickCreateEnabled>0</IsQuickCreateEnabled>
${indent}<SyncToExternalSearchIndex>0</SyncToExternalSearchIndex>
${indent}<IntroducedVersion>1.0.0.0</IntroducedVersion>
${indent}<IsCustomizable>1</IsCustomizable>
${indent}<IsRenameable>1</IsRenameable>
${indent}<IsMappable>1</IsMappable>
${indent}<CanModifyAuditSettings>1</CanModifyAuditSettings>
${indent}<CanCreateAttributes>1</CanCreateAttributes>
${indent}<CanCreateForms>1</CanCreateForms>
${indent}<CanCreateCharts>1</CanCreateCharts>
${indent}<CanCreateViews>1</CanCreateViews>
${indent}<CanModifyAdditionalSettings>1</CanModifyAdditionalSettings>
${indent}<CanEnableSyncToExternalSearchIndex>1</CanEnableSyncToExternalSearchIndex>
${indent}<EnforceStateTransitions>0</EnforceStateTransitions>
${indent}<ChangeTrackingEnabled>1</ChangeTrackingEnabled>
${indent}<IsSolutionAware>0</IsSolutionAware>`;
}

/**
 * Generates an XML attribute block for a non-PK, non-primaryName, non-lookup column.
 * Supports: SingleLine.Text, MultipleLines.Text, Choice, TwoOptions, DateOnly, DateTime,
 *           Decimal, WholeNumber, File.
 */
function columnAttributeXml(col, tableLogicalName, indent = '      ') {
  const physName = col.schemaName || toPhysicalName(col.logicalName);
  const reqLevel = col.required ? 'required' : 'none';

  const TYPE_MAP = {
    'SingleLine.Text':  'nvarchar',
    'MultipleLines.Text': 'nvarchar', // memo/textarea -> still nvarchar in XML, Format=text (see below)
    'Choice':           'picklist',
    'TwoOptions':       'bit',
    'DateOnly':         'datetime',
    'DateTime':         'datetime',
    'Decimal':          'decimal',
    'WholeNumber':      'int',
    'File':             'file',
    'Money':            'money',
  };
  const xmlType = TYPE_MAP[col.type] || 'nvarchar';

  const i  = indent;
  const ii = indent + '  ';

  const imeModeLine  = ['nvarchar', 'datetime'].includes(xmlType) ? `${ii}<ImeMode>auto</ImeMode>\n` : '';
  const validForApi  = xmlType === 'file' ? 0 : 1;

  let typeSpecific = '';

  if (xmlType === 'nvarchar') {
    // Multi-line text (memo) is ALSO nvarchar in Dataverse 9.2 XML — Format must be
    // "text" (NOT "TextArea"/ntext, which fails import with
    // "The format TextArea is not valid for the ntext type"). Only the default
    // MaxLength differs: larger for MultipleLines.Text. <Length> is MaxLength*2 in both cases.
    const defaultMaxLen = col.type === 'MultipleLines.Text' ? 4000 : 200;
    const maxLen = col.maxLength || defaultMaxLen;
    typeSpecific =
      `${ii}<Format>text</Format>\n` +
      `${ii}<MaxLength>${maxLen}</MaxLength>\n` +
      `${ii}<Length>${maxLen * 2}</Length>`;

  } else if (xmlType === 'picklist') {
    const attrLocal = col.logicalName.replace(/^[a-z]+_/, '');
    const colPrefix = (col.logicalName.match(/^([a-z]+)_/) || [])[1] || '';
    const osName = (colPrefix && !tableLogicalName.startsWith(colPrefix + '_'))
      ? `${colPrefix}_${tableLogicalName}_${attrLocal}`
      : `${tableLogicalName}_${attrLocal}`;
    const opts = (col.options || [])
      .map(o =>
        `${ii}  <option value="${o.value}" ExternalValue="" IsHidden="0">\n` +
        `${ii}    <labels><label description="${esc(o.label)}" languagecode="1033" /></labels>\n` +
        `${ii}    <Descriptions><Description description="" languagecode="1033" /></Descriptions>\n` +
        `${ii}  </option>`)
      .join('\n');
    typeSpecific =
      `${ii}<AppDefaultValue>-1</AppDefaultValue>\n` +
      `${ii}<optionset Name="${osName}">\n` +
      `${ii}  <OptionSetType>picklist</OptionSetType>\n` +
      `${ii}  <IntroducedVersion>1.0.0.0</IntroducedVersion>\n` +
      `${ii}  <IsCustomizable>1</IsCustomizable>\n` +
      `${ii}  <ExternalTypeName></ExternalTypeName>\n` +
      `${ii}  <displaynames>\n` +
      `${ii}    <displayname description="${esc(col.displayName)}" languagecode="1033" />\n` +
      `${ii}  </displaynames>\n` +
      `${ii}  <Descriptions><Description description="" languagecode="1033" /></Descriptions>\n` +
      `${ii}  <options>\n` +
      opts + '\n' +
      `${ii}  </options>\n` +
      `${ii}</optionset>`;

  } else if (xmlType === 'bit') {
    const attrLocal = col.logicalName.replace(/^[a-z]+_/, '');
    const colPrefix = (col.logicalName.match(/^([a-z]+)_/) || [])[1] || '';
    const osName = (colPrefix && !tableLogicalName.startsWith(colPrefix + '_'))
      ? `${colPrefix}_${tableLogicalName}_${attrLocal}`
      : `${tableLogicalName}_${attrLocal}`;
    const opts = (col.options || [{ value: 1, label: 'Sì' }, { value: 0, label: 'No' }])
      .map(o =>
        `${ii}  <option value="${o.value}" ExternalValue="" IsHidden="0">\n` +
        `${ii}    <labels><label description="${esc(o.label)}" languagecode="1033" /></labels>\n` +
        `${ii}    <Descriptions><Description description="" languagecode="1033" /></Descriptions>\n` +
        `${ii}  </option>`)
      .join('\n');
    typeSpecific =
      `${ii}<AppDefaultValue>0</AppDefaultValue>\n` +
      `${ii}<optionset Name="${osName}">\n` +
      `${ii}  <OptionSetType>bit</OptionSetType>\n` +
      `${ii}  <IntroducedVersion>1.0.0.0</IntroducedVersion>\n` +
      `${ii}  <IsCustomizable>1</IsCustomizable>\n` +
      `${ii}  <ExternalTypeName></ExternalTypeName>\n` +
      `${ii}  <displaynames>\n` +
      `${ii}    <displayname description="${esc(col.displayName)}" languagecode="1033" />\n` +
      `${ii}  </displaynames>\n` +
      `${ii}  <Descriptions><Description description="" languagecode="1033" /></Descriptions>\n` +
      `${ii}  <options>\n` +
      opts + '\n' +
      `${ii}  </options>\n` +
      `${ii}</optionset>`;

  } else if (xmlType === 'datetime') {
    const behavior = col.type === 'DateOnly' ? 2 : 1;
    const fmt      = col.type === 'DateOnly' ? 'date' : 'datetime';
    typeSpecific =
      `${ii}<Format>${fmt}</Format>\n` +
      `${ii}<CanChangeDateTimeBehavior>1</CanChangeDateTimeBehavior>\n` +
      `${ii}<Behavior>${behavior}</Behavior>`;

  } else if (xmlType === 'decimal') {
    const min       = col.min       !== undefined ? col.min       : -100000000000;
    const max       = col.max       !== undefined ? col.max       :  100000000000;
    const precision = col.precision !== undefined ? col.precision : 2;
    typeSpecific =
      `${ii}<ImeMode>auto</ImeMode>\n` +
      `${ii}<MinValue>${min}</MinValue>\n` +
      `${ii}<MaxValue>${max}</MaxValue>\n` +
      `${ii}<Precision>${precision}</Precision>`;

  } else if (xmlType === 'int') {
    typeSpecific =
      `${ii}<Format>none</Format>\n` +
      `${ii}<MinValue>-2147483648</MinValue>\n` +
      `${ii}<MaxValue>2147483647</MaxValue>`;

  } else if (xmlType === 'file') {
    typeSpecific = `${ii}<MaxValue>32768</MaxValue>`;

  } else if (xmlType === 'money') {
    const min             = col.min             !== undefined ? col.min             : -922337203685477;
    const max             = col.max             !== undefined ? col.max             :  922337203685477;
    const precision       = col.precision       !== undefined ? col.precision       : 2;
    const precisionSource = col.precisionSource !== undefined ? col.precisionSource : 2;
    typeSpecific =
      `${ii}<ImeMode>inactive</ImeMode>\n` +
      `${ii}<MinValue>${min}</MinValue>\n` +
      `${ii}<MaxValue>${max}</MaxValue>\n` +
      `${ii}<Precision>${precision}</Precision>\n` +
      `${ii}<PrecisionSource>${precisionSource}</PrecisionSource>\n` +
      `${ii}<IsBaseCurrency>0</IsBaseCurrency>`;
  }

  return `${i}<attribute PhysicalName="${physName}">
${ii}<Type>${xmlType}</Type>
${ii}<Name>${col.logicalName}</Name>
${ii}<LogicalName>${col.logicalName}</LogicalName>
${ii}<RequiredLevel>${reqLevel}</RequiredLevel>
${ii}<DisplayMask>ValidForAdvancedFind|ValidForForm|ValidForGrid</DisplayMask>
${imeModeLine}${ii}<ValidForUpdateApi>${validForApi}</ValidForUpdateApi>
${ii}<ValidForReadApi>1</ValidForReadApi>
${ii}<ValidForCreateApi>${validForApi}</ValidForCreateApi>
${sharedFlagsXml(1, 1, ii)}
${ii}<IsSearchable>0</IsSearchable>
${ii}<IsFilterable>0</IsFilterable>
${ii}<IsRetrievable>0</IsRetrievable>
${ii}<IsLocalizable>0</IsLocalizable>
${typeSpecific}
${displayBlock(col.displayName, ii)}
${i}</attribute>`;
}

// ─── Full custom table Entity block ──────────────────────────────────────────

function generateTableEntityXml(table, optionValuePrefix) {
  const nameCol = table.columns.find(c => c.isPrimaryName);
  const lookupColLogicals = new Set((table.relationships || []).map(rel => rel.column));

  // Regular columns: everything except PK, primaryName, and lookup columns
  const regularCols = (table.columns || []).filter(c =>
    !c.isPrimaryName &&
    !lookupColLogicals.has(c.logicalName) &&
    c.logicalName !== table.logicalName + 'id'
  );

  const lookupAttrs  = (table.relationships || [])
    .map(rel => lookupAttributeXml(rel.column, rel.columnDisplayName))
    .join('\n');
  const regularAttrs = regularCols
    .map(c => columnAttributeXml(c, table.logicalName))
    .join('\n');

  return `  <Entity xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <Name LocalizedName="${esc(table.displayName)}" OriginalName="${esc(table.displayName)}">${table.schemaName}</Name>
    <EntityInfo>
      <entity Name="${table.schemaName}">
        <LocalizedNames>
          <LocalizedName description="${esc(table.displayName)}" languagecode="1033" />
        </LocalizedNames>
        <LocalizedCollectionNames>
          <LocalizedCollectionName description="${esc(table.pluralDisplayName)}" languagecode="1033" />
        </LocalizedCollectionNames>
        <Descriptions>
          <Description description="" languagecode="1033" />
        </Descriptions>
        <attributes>
${pkAttributeXml(table)}
${nameCol ? nameAttributeXml(nameCol) : ''}
${regularAttrs}
${lookupAttrs}
        </attributes>
${entityMetadataXml(table.logicalName)}
      </entity>
    </EntityInfo>
    <FormXml />
    <SavedQueries />
    <RibbonDiffXml />
  </Entity>`;
}

// ─── Minimal system-table extension Entity block ─────────────────────────────

function generateExtensionEntityXml(ext) {
  const schemaName = ext.schemaName || ext.displayName || ext.logicalName;
  const allAttrs = (ext.columns || [])
    .map(c => {
      if (c.type === 'Lookup') return lookupAttributeXml(c.logicalName, c.displayName);
      return columnAttributeXml(c, ext.logicalName);
    })
    .join('\n');

  return `  <Entity xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <Name LocalizedName="${esc(schemaName)}" OriginalName="${esc(schemaName)}">${schemaName}</Name>
    <EntityInfo>
      <entity Name="${schemaName}">
        <attributes>
${allAttrs}
        </attributes>
      </entity>
    </EntityInfo>
  </Entity>`;
}

// ─── EntityRelationship block ─────────────────────────────────────────────────

function cascadeXml(behavior, indent = '  ') {
  if (behavior === 'Parental') {
    return `${indent}<CascadeAssign>Cascade</CascadeAssign>
${indent}<CascadeDelete>Cascade</CascadeDelete>
${indent}<CascadeArchive>Cascade</CascadeArchive>
${indent}<CascadeReparent>Cascade</CascadeReparent>
${indent}<CascadeShare>Cascade</CascadeShare>
${indent}<CascadeUnshare>Cascade</CascadeUnshare>`;
  }
  return `${indent}<CascadeAssign>NoCascade</CascadeAssign>
${indent}<CascadeDelete>RemoveLink</CascadeDelete>
${indent}<CascadeArchive>RemoveLink</CascadeArchive>
${indent}<CascadeReparent>NoCascade</CascadeReparent>
${indent}<CascadeShare>NoCascade</CascadeShare>
${indent}<CascadeUnshare>NoCascade</CascadeUnshare>`;
}

function generateRelationshipXml(relName, referencingSchemaName, referencedSchemaName, columnLogicalName, behavior) {
  return `  <EntityRelationship Name="${relName}">
    <EntityRelationshipType>OneToMany</EntityRelationshipType>
    <IsCustomizable>1</IsCustomizable>
    <IntroducedVersion>1.0.0.0</IntroducedVersion>
    <IsHierarchical>0</IsHierarchical>
    <ReferencingEntityName>${referencingSchemaName}</ReferencingEntityName>
    <ReferencedEntityName>${referencedSchemaName}</ReferencedEntityName>
${cascadeXml(behavior, '    ')}
    <CascadeRollupView>NoCascade</CascadeRollupView>
    <IsValidForAdvancedFind>1</IsValidForAdvancedFind>
    <ReferencingAttributeName>${columnLogicalName}</ReferencingAttributeName>
    <RelationshipDescription>
      <Descriptions>
        <Description description="" languagecode="1033" />
      </Descriptions>
    </RelationshipDescription>
    <EntityRelationshipRoles>
      <EntityRelationshipRole>
        <NavPaneDisplayOption>UseCollectionName</NavPaneDisplayOption>
        <NavPaneArea>Details</NavPaneArea>
        <NavPaneOrder>10000</NavPaneOrder>
        <NavigationPropertyName>${columnLogicalName}</NavigationPropertyName>
        <RelationshipRoleType>1</RelationshipRoleType>
      </EntityRelationshipRole>
      <EntityRelationshipRole>
        <NavigationPropertyName>${relName}</NavigationPropertyName>
        <RelationshipRoleType>0</RelationshipRoleType>
      </EntityRelationshipRole>
    </EntityRelationshipRoles>
  </EntityRelationship>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── FLOW GENERATORS ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/** Publisher address block (shared by both solution types) */
function publisherAddressesXml(indent = '      ') {
  const nilField = (tag) => `${indent}  <${tag} xsi:nil="true" />`;
  const nilFields = ['City','County','Country','Fax','FreightTermsCode',
    'ImportSequenceNumber','Latitude','Longitude','Line1','Line2','Line3',
    'Name','PostalCode','PostOfficeBox','PrimaryContactName','ShippingMethodCode',
    'StateOrProvince','Telephone1','Telephone2','Telephone3',
    'TimeZoneRuleVersionNumber','UPSZone','UTCOffset','AddressId'];
  return `${indent}<Addresses>
${indent}  <Address>
${indent}    <AddressNumber>1</AddressNumber>
${indent}    <AddressTypeCode>1</AddressTypeCode>
${nilFields.map(nilField).join('\n')}
${indent}  </Address>
${indent}  <Address>
${indent}    <AddressNumber>2</AddressNumber>
${indent}    <AddressTypeCode>1</AddressTypeCode>
${indent}  </Address>
${indent}</Addresses>`;
}

/** solution.xml for flow blueprints (RootComponent type="29" id="{guid}") */
function generateFlowSolutionXml(bp) {
  const { solution, publisher } = bp;
  const displayName = solution.displayName || solution.uniqueName;
  const pubDisplay  = publisher.displayName || publisher.uniqueName;
  const rootComponents = (bp.flows || [])
    .map(f => `      <RootComponent type="29" id="{${f.guid.toLowerCase()}}" behavior="0" />`)
    .join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.26041.172" SolutionPackageVersion="9.2"
    languagecode="1033" generatedBy="CrmLive"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SolutionManifest>
    <UniqueName>${solution.uniqueName}</UniqueName>
    <LocalizedNames>
      <LocalizedName description="${esc(displayName)}" languagecode="1033" />
    </LocalizedNames>
    <Descriptions />
    <Version>${solution.version}</Version>
    <Managed>0</Managed>
    <Publisher>
      <UniqueName>${publisher.uniqueName}</UniqueName>
      <LocalizedNames>
        <LocalizedName description="${esc(pubDisplay)}" languagecode="1033" />
      </LocalizedNames>
      <Descriptions />
      <EMailAddress xsi:nil="true"></EMailAddress>
      <SupportingWebsiteUrl xsi:nil="true"></SupportingWebsiteUrl>
      <CustomizationPrefix>${publisher.prefix}</CustomizationPrefix>
      <CustomizationOptionValuePrefix>${publisher.optionValuePrefix}</CustomizationOptionValuePrefix>
${publisherAddressesXml('      ')}
    </Publisher>
    <RootComponents>
${rootComponents}
    </RootComponents>
    <MissingDependencies />
  </SolutionManifest>
</ImportExportXml>`;
}

/** One <Workflow> block inside <Workflows> */
function workflowEntryXml(flow) {
  const guidLower = flow.guid.toLowerCase();
  const guidUpper = flow.guid.toUpperCase();
  // jsonFile from blueprint (e.g. "Workflows/Name-GUID.json") — ensure leading slash
  const jsonFile = flow.jsonFile
    ? (flow.jsonFile.startsWith('/') ? flow.jsonFile : '/' + flow.jsonFile)
    : `/Workflows/${flow.name}-${guidUpper}.json`;
  const stateCode  = flow.stateCode  ?? 1;
  const statusCode = stateCode === 1 ? 2 : 0;
  const langDesc   = flow.languageDescription || flow.name;

  return `    <Workflow WorkflowId="{${guidLower}}" Name="${esc(flow.name)}">
      <JsonFileName>${esc(jsonFile)}</JsonFileName>
      <Type>1</Type>
      <Subprocess>0</Subprocess>
      <Category>5</Category>
      <Mode>0</Mode>
      <Scope>4</Scope>
      <OnDemand>0</OnDemand>
      <TriggerOnCreate>0</TriggerOnCreate>
      <TriggerOnDelete>0</TriggerOnDelete>
      <AsyncAutodelete>0</AsyncAutodelete>
      <SyncWorkflowLogOnFailure>0</SyncWorkflowLogOnFailure>
      <StateCode>${stateCode}</StateCode>
      <StatusCode>${statusCode}</StatusCode>
      <RunAs>1</RunAs>
      <IsTransacted>1</IsTransacted>
      <IntroducedVersion>1.0</IntroducedVersion>
      <IsCustomizable>1</IsCustomizable>
      <BusinessProcessType>0</BusinessProcessType>
      <IsCustomProcessingStepAllowedForOtherPublishers>1</IsCustomProcessingStepAllowedForOtherPublishers>
      <ModernFlowType>1</ModernFlowType>
      <PrimaryEntity>${esc(flow.primaryEntity || 'none')}</PrimaryEntity>
      <LocalizedNames>
        <LocalizedName languagecode="${flow.languageCode || 1033}" description="${esc(langDesc)}" />
      </LocalizedNames>
    </Workflow>`;
}

/** One <connectionreference> block */
function connRefXml(ref) {
  return `    <connectionreference connectionreferencelogicalname="${esc(ref.logicalName)}">
      <connectionreferencedisplayname>${esc(ref.displayName || ref.logicalName)}</connectionreferencedisplayname>
      <connectorid>${esc(ref.connectorId)}</connectorid>
      <iscustomizable>${ref.isCustomizable ?? 0}</iscustomizable>
      <promptingbehavior>${ref.promptingBehavior ?? 0}</promptingbehavior>
      <statecode>0</statecode>
      <statuscode>1</statuscode>
    </connectionreference>`;
}

/** customizations.xml for flow blueprints */
function generateFlowCustomizationsXml(bp) {
  const workflowBlocks = (bp.flows || []).map(workflowEntryXml).join('\n');
  const connRefBlocks  = (bp.connectionReferences || []).map(connRefXml).join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    OrganizationVersion="9.2.26041.172" OrganizationSchemaType="Standard"
    CRMServerServiceabilityVersion="9.2.26041.00172">
  <Entities></Entities>
  <Roles></Roles>
  <Workflows>
${workflowBlocks}
  </Workflows>
  <FieldSecurityProfiles></FieldSecurityProfiles>
  <Templates />
  <EntityMaps />
  <EntityRelationships />
  <OrganizationSettings />
  <optionsets />
  <CustomControls />
  <EntityDataProviders />
  <connectionreferences>
${connRefBlocks}
  </connectionreferences>
  <Languages>
    <Language>1033</Language>
  </Languages>
</ImportExportXml>`;
}

// ─── solution.xml ─────────────────────────────────────────────────────────────

function generateSolutionXml(blueprint) {
  const { solution, publisher, tables } = blueprint;
  const customTableComponents = tables
    .map(t => `      <RootComponent type="1" schemaName="${t.logicalName}" behavior="0" />`)
    .join('\n');

  // System table extensions need behavior="2" (include subcomponents via reference)
  // Use schemaName from blueprint if provided (needed for custom tables from other solutions
  // where Dataverse requires exact PascalCase schema name, e.g. {prefix}_Installatore not {prefix}_installatore)
  const sysExtComponents = (blueprint.systemTableExtensions || [])
    .map(e => `      <RootComponent type="1" schemaName="${e.schemaName || e.logicalName}" behavior="2" />`)
    .join('\n');

  // System tables referenced only by relationships need behavior="2" to avoid import error
  const relTargets = new Set();
  for (const t of tables) {
    for (const r of t.relationships || []) {
      if (!tables.find(x => x.logicalName === r.targetTable) &&
          !(blueprint.systemTableExtensions || []).find(x => x.logicalName === r.targetTable)) {
        relTargets.add(r.targetTable);
      }
    }
  }
  const relTargetComponents = [...relTargets]
    .map(ln => `      <RootComponent type="1" schemaName="${ln}" behavior="2" />`)
    .join('\n');

  const rootComponents = [customTableComponents, sysExtComponents, relTargetComponents]
    .filter(Boolean).join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.26034.177" SolutionPackageVersion="9.2"
    languagecode="1033" generatedBy="CrmLive"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SolutionManifest>
    <UniqueName>${solution.uniqueName}</UniqueName>
    <LocalizedNames>
      <LocalizedName description="${esc(solution.displayName)}" languagecode="1033" />
    </LocalizedNames>
    <Descriptions />
    <Version>${solution.version}</Version>
    <Managed>0</Managed>
    <Publisher>
      <UniqueName>${publisher.uniqueName}</UniqueName>
      <LocalizedNames>
        <LocalizedName description="${esc(publisher.displayName)}" languagecode="1033" />
      </LocalizedNames>
      <Descriptions />
      <EMailAddress></EMailAddress>
      <SupportingWebsiteUrl></SupportingWebsiteUrl>
      <CustomizationPrefix>${publisher.prefix}</CustomizationPrefix>
      <CustomizationOptionValuePrefix>${publisher.optionValuePrefix}</CustomizationOptionValuePrefix>
      <Addresses>
        <Address>
          <AddressNumber>1</AddressNumber>
          <AddressTypeCode>1</AddressTypeCode>
          <City xsi:nil="true" />
          <County xsi:nil="true" />
          <Country xsi:nil="true" />
          <Fax xsi:nil="true" />
          <FreightTermsCode xsi:nil="true" />
          <ImportSequenceNumber xsi:nil="true" />
          <Latitude xsi:nil="true" />
          <Longitude xsi:nil="true" />
          <Line1 xsi:nil="true" />
          <Line2 xsi:nil="true" />
          <Line3 xsi:nil="true" />
          <Name xsi:nil="true" />
          <PostalCode xsi:nil="true" />
          <PostOfficeBox xsi:nil="true" />
          <PrimaryContactName xsi:nil="true" />
          <ShippingMethodCode xsi:nil="true" />
          <StateOrProvince xsi:nil="true" />
          <Telephone1 xsi:nil="true" />
          <Telephone2 xsi:nil="true" />
          <Telephone3 xsi:nil="true" />
          <TimeZoneRuleVersionNumber xsi:nil="true" />
          <UPSZone xsi:nil="true" />
          <UTCOffset xsi:nil="true" />
          <AddressId xsi:nil="true" />
        </Address>
        <Address>
          <AddressNumber>2</AddressNumber>
          <AddressTypeCode>1</AddressTypeCode>
        </Address>
      </Addresses>
    </Publisher>
    <RootComponents>
${rootComponents}
    </RootComponents>
    <MissingDependencies />
  </SolutionManifest>
</ImportExportXml>`;
}

// ─── customizations.xml ───────────────────────────────────────────────────────

function generateCustomizationsXml(blueprint, schemaMap) {
  // Entity blocks
  const entityBlocks = [];
  for (const table of blueprint.tables) {
    entityBlocks.push(generateTableEntityXml(table));
  }
  for (const ext of blueprint.systemTableExtensions || []) {
    entityBlocks.push(generateExtensionEntityXml(ext));
  }

  // Relationship blocks — collect all lookup definitions
  const relBlocks = [];

  for (const table of blueprint.tables) {
    for (const rel of table.relationships || []) {
      const referencingSchema = table.schemaName;
      const referencedSchema  = schemaMap[rel.targetTable] || toPhysicalName(rel.targetTable);
      relBlocks.push(
        generateRelationshipXml(
          rel.schemaName,
          referencingSchema,
          referencedSchema,
          rel.column,
          rel.behavior
        )
      );
    }
  }

  for (const ext of blueprint.systemTableExtensions || []) {
    const referencingSchema = schemaMap[ext.logicalName] || ext.logicalName;
    for (const col of ext.columns.filter(c => c.type === 'Lookup')) {
      const referencedSchema = schemaMap[col.targetTable] || toPhysicalName(col.targetTable);
      // Derive relationship name: referencedTable_referencingTable_DisplayNoSpaces
      const dispNorm = col.displayName.replace(/\s+/g, '').replace(/[àáâã]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[ìíî]/g, 'i').replace(/[òóôõ]/g, 'o').replace(/[ùúû]/g, 'u');
      const relName = `${col.targetTable}_${ext.logicalName}_${dispNorm}`;
      relBlocks.push(
        generateRelationshipXml(
          relName,
          referencingSchema,
          referencedSchema,
          col.logicalName,
          'Referential'
        )
      );
    }
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.26034.177" SolutionPackageVersion="9.2"
    languagecode="1033" generatedBy="CrmLive"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Entities>
${entityBlocks.join('\n')}
  </Entities>
  <Roles />
  <Workflows />
  <FieldSecurityProfiles />
  <Templates />
  <EntityMaps />
  <EntityRelationships>
${relBlocks.join('\n')}
  </EntityRelationships>
  <OrganizationSettings />
  <optionsets />
  <CustomControls />
  <EntityDataProviders />
</ImportExportXml>`;
}

// ─── [Content_Types].xml ─────────────────────────────────────────────────────

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/octet-stream" />
  <Default Extension="json" ContentType="application/octet-stream" />
</Types>`;

// ─── Core generator ──────────────────────────────────────────────────────────

function generateSolution(blueprintPath, outputDir) {
  const blueprint    = JSON.parse(fs.readFileSync(blueprintPath, 'utf8'));
  const blueprintDir = path.dirname(path.resolve(blueprintPath));

  // Blueprint type detection
  const blueprintType = blueprint.bot ? 'agent' : blueprint.flows ? 'flow' : 'dataverse';

  // Default output to <blueprintDir>/dist
  if (!outputDir) outputDir = path.join(blueprintDir, 'dist');

  // Schema map: logicalName → schemaName — Dataverse only
  const schemaMap = {
    contact: 'Contact',
    systemuser: 'SystemUser',
    team: 'Team',
    account: 'Account',
    opportunity: 'Opportunity',
    appointment: 'Appointment',
  };
  if (blueprintType === 'dataverse') {
    for (const table of blueprint.tables) {
      schemaMap[table.logicalName] = table.schemaName;
    }
  }

  const distSrc = path.join(outputDir, 'src');
fs.mkdirSync(distSrc, { recursive: true });

const contentTypesFile = path.join(distSrc, '[Content_Types].xml');
const solutionFile     = path.join(distSrc, 'solution.xml');
const customFile       = path.join(distSrc, 'customizations.xml');

fs.writeFileSync(contentTypesFile, CONTENT_TYPES_XML, 'utf8');

// ─── Route by blueprint type ─────────────────────────────────────────────────

if (blueprintType === 'agent') {
  // ── Agent solution ─────────────────────────────────────────────────────────
  // Strategy: copy raw/ (full original structure), override Workflows/ with
  // updated flows from flows/, then re-zip preserving folder paths.
  const rawDir   = path.join(blueprintDir, 'raw');
  const flowsDir = path.join(blueprintDir, 'flows');

  if (!fs.existsSync(rawDir)) {
    console.error(`❌ raw/ not found at ${rawDir}`);
    console.error('   Re-run: node scripts/parse-solution.mjs <zip> <output-folder>');
    process.exit(1);
  }

  // Clean dist/src/ first to avoid stale files (e.g., old bot schemaname directories)
  if (fs.existsSync(distSrc)) fs.rmSync(distSrc, { recursive: true, force: true });
  fs.mkdirSync(distSrc, { recursive: true });

  // Copy raw/ → dist/src/ (preserves bots/, botcomponents/, Assets/, etc.)
  function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath  = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) copyDir(srcPath, destPath);
      else fs.copyFileSync(srcPath, destPath);
    }
  }
  copyDir(rawDir, distSrc);

  // Override Workflows/ with updated flows from flows/
  if (fs.existsSync(flowsDir)) {
    const workflowsDir = path.join(distSrc, 'Workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });
    let copiedFlows = 0;
    for (const f of fs.readdirSync(flowsDir)) {
      fs.copyFileSync(path.join(flowsDir, f), path.join(workflowsDir, f));
      copiedFlows++;
    }
    console.log(`   Flows overridden in Workflows/: ${copiedFlows}`);
  }

  console.log(`Written: ${distSrc}`);

  // Create ZIP using AdmZip (preserves folder paths — required for agent solutions)
  const zipPath = path.join(outputDir, `${blueprint.solution.uniqueName}.zip`);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  const zip = new AdmZip();

  function addDirToZip(zip, dirPath, zipBase) {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = path.join(dirPath, entry.name);
      const zipPath  = zipBase ? `${zipBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) addDirToZip(zip, fullPath, zipPath);
      else zip.addFile(zipPath, fs.readFileSync(fullPath));
    }
  }
  addDirToZip(zip, distSrc, '');
  zip.writeZip(zipPath);

  const zipStat = fs.statSync(zipPath);
  const entries = zip.getEntries().length;
  console.log(`\n✅ ZIP created: ${path.resolve(zipPath)}`);
  console.log(`   Size   : ${(zipStat.size / 1024).toFixed(1)} KB`);
  console.log(`   Entries: ${entries}`);

} else if (blueprintType === 'flow') {
  // ── Flow solution ──────────────────────────────────────────────────────────
  fs.writeFileSync(solutionFile, generateFlowSolutionXml(blueprint), 'utf8');
  fs.writeFileSync(customFile,   generateFlowCustomizationsXml(blueprint), 'utf8');

  // Copy flow JSON files into dist/src/Workflows/
  const workflowsDir = path.join(distSrc, 'Workflows');
  fs.mkdirSync(workflowsDir, { recursive: true });

  const flowsSourceDir = path.join(blueprintDir, 'flows');
  let copiedFlows = 0;

  for (const flow of blueprint.flows || []) {
    const guidUpper = flow.guid.toUpperCase();
    const expectedFilename = `${flow.name}-${guidUpper}.json`;
    const srcFile = path.join(flowsSourceDir, expectedFilename);

    if (!fs.existsSync(srcFile)) {
      console.warn(`⚠️  Flow JSON not found: ${srcFile}`);
      continue;
    }
    fs.copyFileSync(srcFile, path.join(workflowsDir, expectedFilename));
    copiedFlows++;
  }

  console.log(`Written:\n   ${contentTypesFile}\n   ${solutionFile}\n   ${customFile}`);
  console.log(`   Flows copied to Workflows/: ${copiedFlows}`);

  // Create ZIP
  const zipPath    = path.join(outputDir, `${blueprint.solution.uniqueName}.zip`);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  const zipPathAbs = path.resolve(zipPath);

  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${path.resolve(distSrc)}\\*' -DestinationPath '${zipPathAbs}' -Force"`,
    { stdio: 'inherit' }
  );

  const zipStat = fs.statSync(zipPathAbs);
  console.log(`\n✅ ZIP created: ${zipPathAbs}`);
  console.log(`   Size: ${(zipStat.size / 1024).toFixed(1)} KB`);
  console.log(`   Flows: ${blueprint.flows?.length ?? 0}`);
  console.log(`   Connection references: ${blueprint.connectionReferences?.length ?? 0}`);

} else {
  // ── Dataverse solution ────────────────────────────────────────────────────
  fs.writeFileSync(solutionFile, generateSolutionXml(blueprint), 'utf8');
  fs.writeFileSync(customFile,   generateCustomizationsXml(blueprint, schemaMap), 'utf8');

  console.log('Written:');
  console.log('  ', contentTypesFile);
  console.log('  ', solutionFile);
  console.log('  ', customFile);

  // Create ZIP using AdmZip (cross-platform — works on Linux/WSL without a
  // powershell.exe dependency; preserves the "exactly 3 files at root" layout)
  const zipPath = path.join(outputDir, `${blueprint.solution.uniqueName}.zip`);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  const distSrcAbs = path.resolve(distSrc);
  const zipPathAbs = path.resolve(zipPath);

  const dvZip = new AdmZip();
  for (const entry of fs.readdirSync(distSrcAbs, { withFileTypes: true })) {
    if (entry.isFile()) {
      dvZip.addFile(entry.name, fs.readFileSync(path.join(distSrcAbs, entry.name)));
    }
  }
  dvZip.writeZip(zipPathAbs);

  const zipStat  = fs.statSync(zipPathAbs);
  const customXml = fs.readFileSync(customFile, 'utf8');
  const entityMatches = (customXml.match(/<Entity xmlns:xsi=/g) || []).length;
  const relMatches    = (customXml.match(/<EntityRelationship Name=/g) || []).length;

  console.log('\n✅ ZIP created:', zipPathAbs);
  console.log(`   Size: ${(zipStat.size / 1024).toFixed(1)} KB`);
  console.log(`   Entity blocks: ${entityMatches}`);
  console.log(`   EntityRelationship blocks: ${relMatches}`);
  console.log(`   Tables in blueprint: ${blueprint.tables.length}`);
}
}

// ─── CLI entry point ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let singleBlueprint = null;
let singleOutput    = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--blueprint' && args[i + 1]) singleBlueprint = args[++i];
  if (args[i] === '--output'    && args[i + 1]) singleOutput    = args[++i];
}

if (singleBlueprint) {
  generateSolution(singleBlueprint, singleOutput);
} else {
  // Auto-discover all *.blueprint.json files one level under power-platform/
  const ppDir = 'power-platform';
  const blueprints = [];

  for (const entry of fs.readdirSync(ppDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(ppDir, entry.name);
    for (const file of fs.readdirSync(projectDir)) {
      if (file.endsWith('.blueprint.json')) {
        blueprints.push(path.join(projectDir, file));
      }
    }
  }

  if (blueprints.length === 0) {
    console.error('❌ No *.blueprint.json files found under power-platform/');
    process.exit(1);
  }

  console.log(`Found ${blueprints.length} blueprint(s):\n`);
  for (const bp of blueprints) {
    console.log(`─── ${bp} ───`);
    generateSolution(bp, null);
    console.log();
  }
}
