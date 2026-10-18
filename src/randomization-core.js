/*
 * ForcePilot - Random value generation core
 * Shared by the side panel and Salesforce content scripts. This module is
 * intentionally dependency-free so generation and validation stay consistent.
 */
(function (root) {
  'use strict';
  if (root.ForcePilotRandomizer?.VERSION === 1) return;

  const FIRST_NAMES = ['Alex','Avery','Blake','Casey','Cameron','Drew','Ellis','Emerson','Finley','Harper','Jamie','Jordan','Kai','Logan','Morgan','Parker','Quinn','Reese','Riley','Rowan','Sage','Skyler','Taylor','Wren'];
  const LAST_NAMES = ['Anderson','Bennett','Brooks','Campbell','Carter','Collins','Cooper','Diaz','Ellis','Foster','Gray','Hayes','Jackson','Kim','Morgan','Parker','Reed','Rivera','Ross','Taylor','Turner','Walker','Warren','Young'];
  const COMPANIES = ['Northstar Labs','Bluebird Systems','Cedar Ridge Group','Silverline Works','Brightpath Studio','Evergreen Partners','Summit Field Services','Maple Gate Solutions','Orbit Point','Willow Creek Digital'];
  const WORDS = ['amber','birch','calm','delta','ember','field','grove','harbor','indigo','juniper','lunar','meadow','north','oak','prairie','quartz','river','summit','timber','upland','vista','willow','zenith'];
  const SENTENCES = ['A sample record for testing and validation.','Review the details and confirm the next step.','This fictional value is generated for a test run.','Please verify the saved values before proceeding.','Example content for a Salesforce test scenario.'];
  const ADDRESSES = {
    US: [
      { street: '123 Example Avenue', city: 'Sample City', state: 'CA', postalCode: '90001', country: 'United States', stateCode: 'CA', countryCode: 'US' },
      { street: '45 Test Road', city: 'Exampleville', state: 'TX', postalCode: '73301', country: 'United States', stateCode: 'TX', countryCode: 'US' },
      { street: '800 Demo Street', city: 'Sampleton', state: 'WA', postalCode: '98001', country: 'United States', stateCode: 'WA', countryCode: 'US' }
    ],
    UK: [
      { street: '12 Example Lane', city: 'Sampleford', state: 'Greater London', postalCode: 'SW1A 1AA', country: 'United Kingdom', countryCode: 'GB' },
      { street: '28 Test Street', city: 'Demoville', state: 'West Midlands', postalCode: 'B1 1AA', country: 'United Kingdom', countryCode: 'GB' }
    ],
    IN: [
      { street: '12 Example Marg', city: 'Samplepur', state: 'Karnataka', postalCode: '560001', country: 'India', stateCode: 'KA', countryCode: 'IN' },
      { street: '45 Test Road', city: 'Demo Nagar', state: 'Tamil Nadu', postalCode: '600001', country: 'India', stateCode: 'TN', countryCode: 'IN' }
    ]
  };

  const text = v => String(v ?? '').trim();
  const number = v => (text(v) !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  const randomUint = () => {
    try { if (root.crypto?.getRandomValues) { const a = new Uint32Array(1); root.crypto.getRandomValues(a); return a[0] / 4294967296; } } catch {}
    return Math.random();
  };
  const randInt = (min, max) => Math.floor(randomUint() * (max - min + 1)) + min;
  const choice = list => list?.length ? list[Math.min(list.length - 1, Math.floor(randomUint() * list.length))] : null;
  const randomId = (length = 6) => {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; let out = '';
    for (let i = 0; i < length; i++) out += chars[randInt(0, chars.length - 1)];
    return out;
  };
  const localDateISO = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  const addLocalDays = (date, days) => { const d = new Date(date.getFullYear(), date.getMonth(), date.getDate()); d.setDate(d.getDate() + days); return d; };
  const parseDateLocal = value => {
    const m = text(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2])-1, Number(m[3]));
    return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2])-1 && d.getDate() === Number(m[3]) ? d : null;
  };
  const dateTimeLocal = date => `${localDateISO(date)}T${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
  const parseDateTimeLocal = value => {
    const m = text(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const parts=[Number(m[1]),Number(m[2])-1,Number(m[3]),Number(m[4]),Number(m[5]),Number(m[6]||0)];
    const d = new Date(parts[0],parts[1],parts[2],parts[3],parts[4],parts[5],0);
    return !Number.isNaN(d.getTime()) && d.getFullYear()===parts[0] && d.getMonth()===parts[1] && d.getDate()===parts[2] && d.getHours()===parts[3] && d.getMinutes()===parts[4] && d.getSeconds()===parts[5] ? d : null;
  };
  const parseTime = value => {
    const m = text(value).match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const timeText = total => `${String(Math.floor(total / 60)).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}`;
  const rawType = step => {
    const t = step?.target || {};
    const candidates = [t.sfDataType, t.salesforceType, t.fieldType, t.type, t.kind].map(x => text(x).toLowerCase()).filter(Boolean);
    // Prefer semantic target.kind and specific Salesforce types over generic DOM
    // fallbacks such as `text` or `field`; otherwise picklists can be misclassified.
    const specific = candidates.find(x => !['field','input','string','text'].includes(x));
    const exact = specific || candidates.find(x => ['string','text'].includes(x)) || '';
    if (exact === 'currency' || exact === 'percent' || exact === 'email' || exact === 'phone' || exact === 'url' || exact === 'address' || exact === 'datetime' || exact === 'date' || exact === 'time' || exact === 'reference' || exact === 'lookup' || exact === 'boolean' || exact === 'checkbox' || exact === 'picklist' || exact === 'multipicklist' || exact === 'multi-picklist' || exact === 'textarea' || exact === 'longtext' || exact === 'longtextarea' || exact === 'richtext') return exact;
    if (['double','int','integer','long','decimal','number'].includes(exact)) return 'number';
    if (candidates.some(x => x.includes('multi') && x.includes('pick'))) return 'multipicklist';
    if (candidates.some(x => x.includes('picklist'))) return 'picklist';
    if (t.multiSelect) return 'multipicklist';
    if (t.reference) return 'reference';
    return 'text';
  };
  const fieldType = step => {
    const t = rawType(step);
    if (t === 'reference' || t === 'lookup') return 'lookup';
    if (t === 'checkbox') return 'boolean';
    if (t === 'string' || t === 'text') return 'text';
    if (t === 'multipicklist' || t === 'multi-picklist') return 'multipicklist';
    if (t === 'longtext' || t === 'longtextarea' || t === 'richtext' || t === 'textarea') return 'longtext';
    if (['double','int','integer','long','decimal'].includes(t)) return 'number';
    return t;
  };
  const guessStrategy = (step, type = fieldType(step)) => {
    const target = step?.target || {};
    const label = `${text(target.label)} ${text(target.apiName)} ${text(target.name)}`.toLowerCase().replace(/[_-]+/g,' ');
    if (type === 'lookup') return step?.meta?.createNewRecord?.fields ? 'lookupCreate' : 'lookupRandom';
    if (type === 'address') return 'address';
    if (type === 'boolean') return 'boolean';
    // Random Option is the safest default for every picklist: runtime selection uses the live options,
    // while the alternative strategy lets users restrict the random choice to specific known values.
    if (type === 'picklist') return 'dependentPicklist';
    if (type === 'multipicklist') return 'multiPicklist';
    if (type === 'currency') return 'currencyRange';
    if (type === 'percent') return 'percentRange';
    if (type === 'number') return 'numberRange';
    if (type === 'date') return 'relativeDate';
    if (type === 'datetime') return 'dateTimeRange';
    if (type === 'time') return 'timeRange';
    if (type === 'email' || (type === 'text' && /\b(email|e mail)\b/.test(label))) return 'email';
    if (type === 'phone' || (type === 'text' && /\b(phone|telephone|mobile|fax)\b/.test(label))) return 'phone';
    if (type === 'url' || (type === 'text' && /\b(url|website|web site|site url)\b/.test(label))) return 'url';
    if (type === 'text' && /\b(first name|firstname|given name)\b/.test(label)) return 'firstName';
    if (type === 'text' && /\b(last name|lastname|surname|family name)\b/.test(label)) return 'lastName';
    if (type === 'text' && /\b(full name|contact name|display name)\b/.test(label)) return 'fullName';
    if (type === 'text' && /\b(company|account name|organisation|organization)\b/.test(label)) return 'company';
    if (type === 'longtext' || (type === 'text' && /\b(description|comment|notes|details|message)\b/.test(label))) return 'paragraph';
    if (type === 'text') return 'textPrefixUnique';
    return 'text';
  };
  const strategies = step => {
    const type = fieldType(step);
    if (type === 'text') return [
      ['textPrefixUnique','Custom Text + Unique ID'],['text','Random text'],['firstName','First name'],['lastName','Last name'],['fullName','Full name'],['company','Company name'],['paragraph','Sentence / paragraph'],['email','Test email'],['phone','Phone number'],['url','Test URL']
    ].map(([value,label])=>({value,label}));
    if (type === 'longtext') return [{value:'paragraph',label:'Sentence / paragraph'},{value:'text',label:'Random text'}];
    const one = {
      email:[['email','Test email']], phone:[['phone','Phone number']], url:[['url','Test URL']], number:[['numberRange','Number range'],['numberRangeIncrement','Number range with increment']], currency:[['currencyRange','Currency range']], percent:[['percentRange','Percentage range']], date:[['relativeDate','Relative to current Date'],['dateRange','Date Range']], datetime:[['dateTimeRange','Date/time window (experimental)']], time:[['timeRange','Time range']], boolean:[['boolean','Random checked / unchecked']], picklist:[['dependentPicklist','Select a Random Option'],['picklist','Select randomly from specific values']], multipicklist:[['multiPicklist','Available multi-select options']], address:[['address','Coherent sample address']]
    }[type];
    if (type === 'lookup') {
      const out = [];
      if (step?.meta?.createNewRecord?.fields) out.push({value:'lookupCreate',label:'Create new record (recorded workflow)'});
      out.push({value:'lookupRandom',label:'Random existing record'});
      return out;
    }
    return (one || [['text','Random text']]).map(([value,label])=>({value,label}));
  };
  const defaults = (step, strategyOverride) => {
    const type = fieldType(step); const strategy = strategyOverride || guessStrategy(step, type);
    const now = new Date(); const dateStart = localDateISO(addLocalDays(now,-30)); const dateEnd = localDateISO(addLocalDays(now,30));
    const target = step?.target || {}; const scalePresent = target.scale !== undefined && target.scale !== null && text(target.scale) !== ''; const scale = scalePresent && Number.isInteger(Number(target.scale)) ? Math.max(0,Math.min(10,Number(target.scale))) : null;
    let options = {};
    if (strategy === 'text') { const maxLength = Math.max(1, Math.min(18, Number(target.length || target.maxLength || 255) || 18)); options = { minLength: Math.min(6, maxLength), maxLength }; }
    if (strategy === 'paragraph') { const maxLength = Math.max(1, Math.min(120, Number(target.length || target.maxLength || 4000) || 120)); options = { minLength: Math.min(24, maxLength), maxLength }; }
    if (strategy === 'email') options = { domain: 'example.com', unique: true };
    if (strategy === 'phone') options = { country: 'US' };
    if (strategy === 'url') options = { domain: 'example.com' };
    if (strategy === 'numberRange') options = { min: 1, max: 100, decimals: scale ?? 0 };
    if (strategy === 'numberRangeIncrement') options = { min: 1, max: 100, step: 1, decimals: scale ?? 0 };
    if (strategy === 'currencyRange') options = { min: 1, max: 1000, step: scale !== null ? (scale > 0 ? Number(`0.${'0'.repeat(Math.max(0,scale-1))}1`) : 1) : 0.01, decimals: scale ?? 2 };
    if (strategy === 'percentRange') options = { min: 1, max: 100, step: scale !== null && scale > 0 ? Number(`0.${'0'.repeat(Math.max(0,scale-1))}1`) : 1, decimals: scale ?? 0 };
    const recordedOffset = (() => {
      const m = step?.meta || {};
      if (m.dateMode === 'relative' && Number.isFinite(Number(m.dateOffsetDays))) return Number(m.dateOffsetDays);
      const recordedOn = parseDateLocal(m.dateRecordedOn || step?.recordingDate || '');
      const recordedValue = parseDateLocal(String(step?.value ?? '').slice(0, 10));
      if (recordedOn && recordedValue) return Math.round((recordedValue.getTime() - recordedOn.getTime()) / 86400000);
      return 0;
    })();
    if (strategy === 'textPrefixUnique') {
      const targetLength = Math.max(1, Number(target.length || target.maxLength || 255) || 255);
      const recorded = text(typeof step?.value === 'object' ? step.value?.displayValue : step?.value);
      const prefix = (recorded || 'Test Property').slice(0, Math.max(1, targetLength - 6));
      options = { prefix, unique: true };
    }
    // Date Range uses absolute From/To date pickers. Relative-to-current-date is
    // the Today +/- N days mode and is the default for newly randomized date fields.
    if (strategy === 'dateRange') options = { startDate: dateStart, endDate: dateEnd };
    if (strategy === 'relativeDate') options = { sign: recordedOffset < 0 ? '-' : '+', days: Math.abs(recordedOffset) };
    if (strategy === 'dateTimeRange') options = { fromDays: recordedOffset - 7, toDays: recordedOffset + 7, direction: 'any', weekdaysOnly: false, startTime: '09:00', endTime: '17:00', stepMinutes: 15 };
    if (strategy === 'timeRange') options = { startTime: '09:00', endTime: '17:00', stepMinutes: 15 };
    if (strategy === 'boolean') options = { mode: 'random' };
    if (strategy === 'dependentPicklist') options = {};
    if (strategy === 'multiPicklist') { const count = validOptions(step).length; options = { minSelections: 1, maxSelections: count ? Math.min(3, count) : 3 }; }
    if (strategy === 'lookupRandom') options = { searchTerm: '' };
    if (strategy === 'lookupCreate') options = {};
    if (strategy === 'address') {
      const existingAddress = step?.value && typeof step.value === 'object' ? step.value : {};
      const countryHint = text(existingAddress.countryCode || existingAddress.country || '').toLowerCase();
      const country = /^(in|india|indian)$/.test(countryHint) ? 'IN' : /^(gb|uk|united kingdom|great britain)$/.test(countryHint) ? 'UK' : 'US';
      options = { country };
    }
    return { version: 1, enabled: false, strategy, options };
  };
  const validOptions = step => {
    const raw = Array.isArray(step?.target?.options) ? step.target.options : [];
    const seen = new Set();
    return raw.filter(o => o && o.active !== false).map(o => ({ ...o, value: text(o.value ?? o.displayValue), label: text(o.displayValue ?? o.label ?? o.value) })).filter(o => {
      const key = o.label.toLowerCase(); if (!o.label || seen.has(key)) return false; seen.add(key); return true;
    });
  };
  const allowedOptions = (step, cfg) => {
    const all = validOptions(step); const allowed = cfg?.options?.allowedValues;
    // A dependent picklist must be generated from the choices Salesforce exposes
    // for the live controlling value. Any persisted allow-list came from a previous
    // controller value and must not filter today's eligible choices.
    if (text(cfg?.strategy) === 'dependentPicklist') return all;
    if (!Array.isArray(allowed)) return all;
    const set = new Set(allowed.map(v=>text(v).toLowerCase()));
    return all.filter(o=>set.has(o.label.toLowerCase()) || set.has(o.value.toLowerCase()));
  };
  const validate = (step, config) => {
    const cfg = config || {}; if (!cfg.enabled) return { ok: true };
    const strategy = text(cfg.strategy || guessStrategy(step)); const o = cfg.options || {}; const type = fieldType(step); const numeric = ['numberRange','numberRangeIncrement','currencyRange','percentRange'].includes(strategy);
    if (!strategies(step).some(s => s.value === strategy)) return { ok:false, error:'Choose a generation type supported by this field.' };
    if (numeric) {
      const min = number(o.min), max = number(o.max), decimals = number(o.decimals);
      const usesIncrement = strategy !== 'numberRange';
      const stepSize = usesIncrement ? number(o.step) : null;
      if (min === null || max === null) return {ok:false,error:'Enter both a minimum and maximum.'};
      if (min > max) return {ok:false,error:'Minimum must be less than or equal to maximum.'};
      if (usesIncrement && (stepSize === null || stepSize <= 0)) return {ok:false,error:'Increment must be greater than zero.'};
      if (decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 10) return {ok:false,error:'Decimal places must be a whole number from 0 to 10.'};
      const rawScale=step?.target?.scale;const targetScale=rawScale!==undefined&&rawScale!==null&&text(rawScale)!==''?Number(rawScale):null;
      if (Number.isInteger(targetScale) && targetScale >= 0 && decimals > targetScale) return {ok:false,error:`This field supports at most ${targetScale} decimal place${targetScale===1?'':'s'}.`};
      const decimalPlaces = value => { const raw=String(value).toLowerCase(); if(raw.includes('e')) { const [co,exp]=raw.split('e'); return Math.max(0,(co.split('.')[1]||'').length-Number(exp)); } return (raw.split('.')[1]||'').length; };
      const precisionInputs=usesIncrement?[min,max,stepSize]:[min,max];
      if (precisionInputs.some(value => decimalPlaces(value) > decimals)) return {ok:false,error:`Minimum, maximum${usesIncrement?' and increment':''} must use at most ${decimals} decimal place${decimals===1?'':'s'}.`};
      const precisionRaw=step?.target?.precision;const precision=precisionRaw!==undefined&&precisionRaw!==null&&text(precisionRaw)!==''?Number(precisionRaw):null;
      if(Number.isInteger(precision)&&precision>0&&Number.isInteger(targetScale)&&targetScale>=0){const magnitudeLimit=Math.pow(10,Math.max(1,precision-targetScale));if(Math.abs(min)>=magnitudeLimit||Math.abs(max)>=magnitudeLimit)return{ok:false,error:`The range exceeds this field's ${precision}-digit precision.`};}
      if (usesIncrement && Math.floor((max - min) / stepSize + 1e-9) < 0) return {ok:false,error:'No values fit this range and increment.'};
      if (!usesIncrement) { const factor=Math.pow(10,decimals); if(Math.ceil(min*factor-1e-8)>Math.floor(max*factor+1e-8))return{ok:false,error:'No values fit this range at the selected decimal precision.'}; }
    }
    if (strategy === 'relativeDate') { const days=number(o.days); if(days===null||!Number.isInteger(days)||days<0||days>36500||!['+','-'].includes(text(o.sign||'+')))return {ok:false,error:'Choose a valid Today +/- days value.'}; }
    if (strategy === 'dateRange') {
      if (o.fromDays !== undefined || o.toDays !== undefined) {
        const from = number(o.fromDays), to = number(o.toDays), direction = text(o.direction || 'any');
        if (from === null || to === null || !Number.isInteger(from) || !Number.isInteger(to) || Math.abs(from) > 36500 || Math.abs(to) > 36500) return {ok:false,error:'From/to days must be whole numbers between -36,500 and 36,500.'};
        if (from > to) return {ok:false,error:'From days must be less than or equal to To days.'};
        if (!['any','past','future'].includes(direction)) return {ok:false,error:'Choose Any, Past only, or Future only.'};
        const low = direction === 'past' ? from : direction === 'future' ? Math.max(0, from) : from;
        const high = direction === 'future' ? to : direction === 'past' ? Math.min(0, to) : to;
        if (low > high) return {ok:false,error:'The day range does not include any dates for the selected past/future preset.'};
        if (o.weekdaysOnly && !Array.from({length:Math.min(36601, high-low+1)},(_,i)=>i+low).some(offset=>{const d=addLocalDays(new Date(),offset).getDay();return d!==0&&d!==6;})) return {ok:false,error:'The selected range contains no weekdays.'};
      } else {
        const a = parseDateLocal(o.startDate), b = parseDateLocal(o.endDate);
        if (!a || !b) return {ok:false,error:'Enter valid start and end dates.'};
        if (a > b) return {ok:false,error:'Start date must be on or before end date.'};
      }
    }
    if (strategy === 'dateTimeRange') {
      const inc = number(o.stepMinutes);
      if (o.fromDays !== undefined || o.toDays !== undefined) {
        const from = number(o.fromDays), to = number(o.toDays), direction = text(o.direction || 'any');
        if (from === null || to === null || !Number.isInteger(from) || !Number.isInteger(to) || Math.abs(from) > 36500 || Math.abs(to) > 36500) return {ok:false,error:'From/to days must be whole numbers between -36,500 and 36,500.'};
        if (from > to) return {ok:false,error:'From days must be less than or equal to To days.'};
        if (!['any','past','future'].includes(direction)) return {ok:false,error:'Choose Any, Past only, or Future only.'};
        const startTime = parseTime(o.startTime), endTime = parseTime(o.endTime);
        if (startTime === null || endTime === null || startTime > endTime) return {ok:false,error:'Enter a valid time window with start time on or before end time.'};
        const low = direction === 'past' ? from : direction === 'future' ? Math.max(0, from) : from;
        const high = direction === 'future' ? to : direction === 'past' ? Math.min(0, to) : to;
        if (low > high) return {ok:false,error:'The day range does not include any dates for the selected past/future preset.'};
        if (o.weekdaysOnly && !Array.from({length:Math.min(73001,high-low+1)},(_,i)=>i+low).some(offset=>{const d=addLocalDays(new Date(),offset);return d.getDay()!==0&&d.getDay()!==6;})) return {ok:false,error:'The selected range contains no weekdays.'};
      } else {
        const a = parseDateTimeLocal(o.startDateTime), b = parseDateTimeLocal(o.endDateTime);
        if (!a || !b) return {ok:false,error:'Enter valid start and end date/time values.'};
        if (a > b) return {ok:false,error:'Start date/time must be on or before the end.'};
      }
      if (inc === null || !Number.isInteger(inc) || inc < 1 || inc > 1440) return {ok:false,error:'Minute increment must be a whole number from 1 to 1,440.'};
      if ((o.weekdaysOnly) && Number(o.toDays)-Number(o.fromDays)>36500) return {ok:false,error:'Date window is too large.'};
    }
    if (strategy === 'timeRange') {
      const a = parseTime(o.startTime), b = parseTime(o.endTime), inc = number(o.stepMinutes);
      if (a === null || b === null) return {ok:false,error:'Enter valid start and end times.'};
      if (a > b) return {ok:false,error:'Start time must be on or before end time.'};
      if (inc === null || !Number.isInteger(inc) || inc < 1 || inc > 1440) return {ok:false,error:'Minute increment must be a whole number from 1 to 1,440.'};
    }
    if (strategy === 'textPrefixUnique') {
      const prefix = text(o.prefix);
      const targetLength = Number(step?.target?.length || step?.target?.maxLength || 0);
      if (!prefix) return {ok:false,error:'Enter custom text to use before the unique ID.'};
      if (targetLength > 0 && targetLength < 6) return {ok:false,error:'This field needs at least 6 characters for the custom text and unique ID.'};
      if (targetLength > 0 && prefix.length + 5 > targetLength) return {ok:false,error:`Keep Custom Text to ${Math.max(1,targetLength-5)} characters or fewer for this field.`};
    }
    if (['text','paragraph'].includes(strategy)) {
      const min = number(o.minLength), max = number(o.maxLength);
      if (min === null || max === null || !Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) return {ok:false,error:'Text length must be a positive whole-number range.'};
      const targetLength = Number(step?.target?.length || step?.target?.maxLength || 0);
      if (targetLength > 0 && max > targetLength) return {ok:false,error:`Maximum length cannot exceed the ${targetLength}-character field limit.`};
    }
    if (strategy === 'multiPicklist' || strategy === 'picklist' || strategy === 'dependentPicklist') {
      const allOptions = validOptions(step);
      const opts = allowedOptions(step,cfg);
      // A recording does not always contain a complete option catalogue. Salesforce
      // Lightning (especially dependent picklists) often exposes the valid options
      // only from the live control after the controlling value has been applied.
      // Defer empty-catalogue validation until generation, after runtime hydration.
      // Still reject an explicitly empty allow-list, because that means the user
      // deliberately disabled every option.
      if (strategy !== 'dependentPicklist' && Array.isArray(o.allowedValues) && o.allowedValues.length === 0) return {ok:false,error:'Allow at least one option, or clear the option restrictions.'};
      if (strategy !== 'dependentPicklist' && allOptions.length && Array.isArray(o.allowedValues) && o.allowedValues.length && !opts.length) return {ok:false,error:'None of the allowed options match Salesforce options. Refresh field metadata or update the allowed options.'};
      if (strategy === 'multiPicklist') {
        const min = number(o.minSelections), max = number(o.maxSelections);
        if (min === null || max === null || !Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) return {ok:false,error:'Selection counts must be whole numbers, with a minimum of at least 1.'};
        if (opts.length && max > opts.length) return {ok:false,error:`Maximum selections cannot exceed the ${opts.length} allowed option${opts.length===1?'':'s'}.`};
      }
    }
    if (strategy === 'boolean' && !['random','true','false'].includes(text(o.mode || 'random'))) return {ok:false,error:'Choose Random, Always checked, or Always unchecked.'};
    if (strategy === 'lookupRandom') {
      const term = text(o.searchTerm); if (term.length > 100) return {ok:false,error:'Lookup search text must be 100 characters or fewer.'};
    }
    if (['email','url'].includes(strategy)) {
      const domain = text(o.domain || 'example.com');
      if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?:\.[a-z]{2,}|\.example)$/i.test(domain) || domain.includes('..')) return {ok:false,error:'Enter a valid domain, such as example.com.'};
    }
    return { ok:true };
  };
  const normalizeDecimal = (n, decimals) => Number(Number(n).toFixed(Math.max(0,Math.min(10,decimals))));
  const generate = (step, config, runState = {}, uniqueRetry = 0) => {
    const cfg = config || {}; const o = cfg.options || {}; const strategy = text(cfg.strategy || guessStrategy(step));
    const validation = validate(step,cfg); if (!validation.ok) return validation;
    if (strategy === 'lookupRandom') return {ok:true, lookup:true, searchTerm:text(o.searchTerm)};
    if (strategy === 'lookupCreate') return {ok:true, value:step?.value, metaPatch:{}, preserveCreateWorkflow:true};
    let value; let metaPatch = {};
    if (strategy === 'firstName') value = choice(FIRST_NAMES);
    else if (strategy === 'lastName') value = choice(LAST_NAMES);
    else if (strategy === 'fullName') value = `${choice(FIRST_NAMES)} ${choice(LAST_NAMES)}`;
    else if (strategy === 'company') value = `${choice(COMPANIES)}${o.unique ? ` ${randomId(4).toUpperCase()}` : ''}`;
    else if (strategy === 'text' || strategy === 'paragraph') {
      const min = Number(o.minLength || (strategy === 'paragraph' ? 24 : 6)); const max = Number(o.maxLength || (strategy === 'paragraph' ? 120 : 18));
      const targetLength = Number(step?.target?.length || step?.target?.maxLength || 0);
      const length = randInt(min, Math.max(min, Math.min(max, targetLength || max)));
      const chunks = [];
      while (chunks.join(' ').length < length + 20) chunks.push(choice(WORDS));
      value = chunks.join(' ').slice(0, length).trim();
      if (value.length < length) value = `${value}${randomId(length-value.length)}`.slice(0,length);
      if (o.unique) value = `${value.slice(0,Math.max(1,length-5))}-${randomId(4)}`.slice(0,targetLength || max);
    } else if (strategy === 'textPrefixUnique') {
      const prefix = text(o.prefix || 'Test Property');
      const targetLength = Number(step?.target?.length || step?.target?.maxLength || 0);
      const suffix = randomId(4);
      value = `${prefix.slice(0, targetLength > 0 ? Math.max(1,targetLength-suffix.length-1) : prefix.length)} ${suffix}`.trim();
      if (targetLength > 0) value = value.slice(0,targetLength);
      if (runState.usedValues instanceof Set) {
        const uniqueKey = () => `textPrefixUnique:${value.toLowerCase()}`;
        let tries = 0;
        while (runState.usedValues.has(uniqueKey()) && tries++ < 40) {
          value = `${prefix.slice(0, targetLength > 0 ? Math.max(1,targetLength-5) : prefix.length)} ${randomId(4)}`.trim();
          if (targetLength > 0) value = value.slice(0,targetLength);
        }
        if (runState.usedValues.has(uniqueKey())) return {ok:false,error:'Could not generate a unique ID. Shorten Custom Text or retry.'};
        runState.usedValues.add(uniqueKey());
      }
    } else if (strategy === 'email') {
      const domain = text(o.domain || 'example.com').toLowerCase();
      value = `qa+${randomId(8)}@${domain}`;
    } else if (strategy === 'phone') {
      const country = text(o.country || 'US').toUpperCase();
      if (country === 'US') value = `(202) 555-01${String(randInt(0,99)).padStart(2,'0')}`;
      else if (country === 'IN') value = `+91 ${randInt(6,9)}${String(randInt(0,999999999)).padStart(9,'0')}`;
      else if (country === 'UK') value = `+44 7700 900${String(randInt(0,99)).padStart(2,'0')}`;
      else value = `+${randInt(1,99)} ${String(randInt(0,9999999999)).padStart(10,'0')}`;
    } else if (strategy === 'url') {
      const domain = text(o.domain || 'example.com').toLowerCase();
      value = `https://${domain}/test/${randomId(7)}`;
    } else if (['numberRange','numberRangeIncrement','currencyRange','percentRange'].includes(strategy)) {
      const min = Number(o.min), max = Number(o.max), decimals = Number(o.decimals);
      const usesIncrement = strategy !== 'numberRange';
      const factor = Math.pow(10, decimals);
      let count;
      if (usesIncrement) {
        let increment = Number(o.step);
        // If the Percent decimals control differs from the Salesforce-scale
        // default, and the increment still equals that default, treat it as
        // auto-managed and use the selected decimal precision. Custom increments
        // remain authoritative.
        const scaleRaw=step?.target?.scale;const targetScale=scaleRaw!==undefined&&scaleRaw!==null&&text(scaleRaw)!==''&&Number.isInteger(Number(scaleRaw))?Math.max(0,Math.min(10,Number(scaleRaw))):null;
        const defaultPercentStep=targetScale===null?1:1/Math.pow(10,targetScale);
        const autoPercentStep=strategy==='percentRange'&&(targetScale===null?decimals>0:decimals!==targetScale)&&Math.abs(increment-defaultPercentStep)<1e-12;
        if(autoPercentStep)increment=1/factor;
        count = Math.floor((max-min)/increment + 1e-9);
        if (count > 100000000) return {ok:false,error:'This numeric range is too large. Increase the increment or narrow the range.'};
        const zeroIndex = Math.round((0-min)/increment);
        const zeroFits = zeroIndex >= 0 && zeroIndex <= count && Math.abs(min+zeroIndex*increment) < 1e-8;
        if (count + 1 - (zeroFits ? 1 : 0) < 1) return {ok:false,error:'This range has no non-zero values. Widen the range.'};
        let index = randInt(0, count-(zeroFits?1:0));
        if (zeroFits && index >= zeroIndex) index++;
        value = normalizeDecimal(min + index*increment, decimals);
      } else {
        // Number range samples directly at the selected decimal precision, but never emits zero.
        const low = Math.ceil(min*factor-1e-8), high = Math.floor(max*factor+1e-8);
        count = high-low;
        if (count < 0) return {ok:false,error:'No values fit this range at the selected decimal precision.'};
        if (count > 100000000) return {ok:false,error:'This numeric range is too large. Narrow the range or reduce decimal places.'};
        const zeroFits = low <= 0 && high >= 0;
        if (high-low+1-(zeroFits?1:0) < 1) return {ok:false,error:'This range has no non-zero values. Widen the range.'};
        let integer = randInt(low, high-(zeroFits?1:0));
        if (zeroFits && integer >= 0) integer++;
        value = normalizeDecimal(integer/factor, decimals);
      }
      // Number ranges intentionally do not offer uniqueness. Preserve it for the
      // currency/percent and explicit increment strategies only when requested.
      if (o.unique && !['numberRange','numberRangeIncrement'].includes(strategy) && runState.usedValues instanceof Set) {
        const keyPrefix = `number:${strategy}:`;
        const scaleRaw=step?.target?.scale;const targetScale=scaleRaw!==undefined&&scaleRaw!==null&&text(scaleRaw)!==''&&Number.isInteger(Number(scaleRaw))?Math.max(0,Math.min(10,Number(scaleRaw))):null;
        const defaultPercentStep=targetScale===null?1:1/Math.pow(10,targetScale);
        const autoPercentStep=strategy==='percentRange'&&(targetScale===null?decimals>0:decimals!==targetScale)&&Math.abs(Number(o.step)-defaultPercentStep)<1e-12;
        const uniqueIncrement = autoPercentStep ? 1 / factor : Number(o.step);
        if (count < 10000) {
          const candidates = Array.from({length:count+1},(_,i)=>normalizeDecimal(min+i*uniqueIncrement,decimals)).filter(n=>n!==0&&!runState.usedValues.has(keyPrefix+n));
          if (!candidates.length) return {ok:false,error:'No unused values remain in this range. Widen the range or turn off uniqueness.'};
          value = choice(candidates);
        } else {
          let tries=0; while((value===0||runState.usedValues.has(keyPrefix+value)) && tries++<30) value=normalizeDecimal(min+randInt(0,count)*uniqueIncrement,decimals);
          if(value===0||runState.usedValues.has(keyPrefix+value))return{ok:false,error:'Could not find a unique non-zero value in this range. Widen the range.'};
        }
        runState.usedValues.add(keyPrefix+value);
      }
    } else if (strategy === 'relativeDate') {
      const days=Math.max(0,Math.min(36500,Math.floor(Number(o.days)||0)));const base=new Date();base.setHours(0,0,0,0);base.setDate(base.getDate()+(o.sign==='-'?-days:days));value=localDateISO(base);metaPatch={randomizedDate:true};
    } else if (strategy === 'dateRange') {
      if (o.fromDays !== undefined || o.toDays !== undefined) {
        let low=Number(o.fromDays), high=Number(o.toDays);
        if (o.direction==='past') high=Math.min(high,0); else if (o.direction==='future') low=Math.max(low,0);
        const eligible=[]; const today=new Date();
        for(let offset=low;offset<=high;offset++){const candidate=addLocalDays(today,offset);if(!o.weekdaysOnly||![0,6].includes(candidate.getDay()))eligible.push(candidate);}
        if(!eligible.length)return{ok:false,error:'No dates are available for this window and preset.'};
        value=localDateISO(choice(eligible));
      } else {
        const start = parseDateLocal(o.startDate), end = parseDateLocal(o.endDate);
        const days = Math.round((new Date(end.getFullYear(),end.getMonth(),end.getDate()) - new Date(start.getFullYear(),start.getMonth(),start.getDate())) / 86400000);
        value = localDateISO(addLocalDays(start, randInt(0,days)));
      }
      metaPatch = {randomizedDate:true};
    } else if (strategy === 'dateTimeRange') {
      const inc = Number(o.stepMinutes);
      if(o.fromDays !== undefined || o.toDays !== undefined){
        let low=Number(o.fromDays),high=Number(o.toDays);
        if(o.direction==='past')high=Math.min(high,0);else if(o.direction==='future')low=Math.max(low,0);
        const startTime=parseTime(o.startTime),endTime=parseTime(o.endTime),eligible=[];const today=new Date();
        for(let offset=low;offset<=high;offset++){const day=addLocalDays(today,offset);if(o.weekdaysOnly&&[0,6].includes(day.getDay()))continue;eligible.push(day);}
        if(!eligible.length)return{ok:false,error:'No date/time values are available for this window and preset.'};
        const day=choice(eligible),slots=Math.floor((endTime-startTime)/inc),minute=startTime+randInt(0,Math.max(0,slots))*inc;
        value=dateTimeLocal(new Date(day.getFullYear(),day.getMonth(),day.getDate(),Math.floor(minute/60),minute%60,0,0));
      } else {
      const start = parseDateTimeLocal(o.startDateTime), end = parseDateTimeLocal(o.endDateTime);
      // Work on the local wall-clock timeline, not elapsed milliseconds. Adding
      // fixed milliseconds to a local Date can shift the displayed hour across
      // daylight-saving transitions even though the configured time is local.
      const civilStamp = d => Date.UTC(d.getFullYear(),d.getMonth(),d.getDate(),d.getHours(),d.getMinutes());
      const startStamp=civilStamp(start),endStamp=civilStamp(end),slots=Math.floor((endStamp-startStamp)/(inc*60000));
      let d=null;
      for(let attempt=0;attempt<64;attempt++){
        const civil=new Date(startStamp+randInt(0,Math.max(0,slots))*inc*60000);
        const candidate=new Date(civil.getUTCFullYear(),civil.getUTCMonth(),civil.getUTCDate(),civil.getUTCHours(),civil.getUTCMinutes(),0,0);
        // Local Date construction normalizes nonexistent clock times during a
        // spring DST gap; reject those so the generated value still fits the step.
        if(candidate.getFullYear()===civil.getUTCFullYear()&&candidate.getMonth()===civil.getUTCMonth()&&candidate.getDate()===civil.getUTCDate()&&candidate.getHours()===civil.getUTCHours()&&candidate.getMinutes()===civil.getUTCMinutes()){d=candidate;break;}
      }
      value = dateTimeLocal(d||start);
      }
    } else if (strategy === 'timeRange') {
      const start = parseTime(o.startTime), end = parseTime(o.endTime), inc = Number(o.stepMinutes);
      const slots = Math.floor((end-start)/inc); value = timeText(start+randInt(0,Math.max(0,slots))*inc);
    } else if (strategy === 'boolean') {
      value = text(o.mode || 'random') === 'true' ? true : text(o.mode || 'random') === 'false' ? false : randomUint() >= .5;
    } else if (strategy === 'picklist' || strategy === 'dependentPicklist') {
      const opts = allowedOptions(step,cfg);
      const target = step?.target || {};
      const dependencyKnown = !!(target.isDependentPicklist || target.controllerName || (Array.isArray(target.controllingFields) && target.controllingFields.length) || (target.controllerValues && Object.keys(target.controllerValues).length));
      if (!opts.length) return {ok:false,error:strategy === 'dependentPicklist' && dependencyKnown ? 'No options are available for the controlling field’s current value. Ensure the controller is filled first.' : 'No selectable Salesforce options were resolved for this field. Refresh field metadata or check that the field has available options.'};
      const hit = choice(opts); if(!hit)return{ok:false,error:'Salesforce did not provide a selectable option for this field.'}; value = hit.value || hit.label; metaPatch = {selectedDisplayValue:hit.label};
    } else if (strategy === 'multiPicklist') {
      const opts = allowedOptions(step,cfg).slice(); if(!opts.length)return{ok:false,error:'No selectable Salesforce options were resolved for this field. Refresh the field or check that its controlling field has a valid value.'}; const min = Number(o.minSelections), max = Number(o.maxSelections); const count = randInt(min, Math.min(max,opts.length)); const values = [];
      while(values.length<count && opts.length){ const idx=randInt(0,opts.length-1); values.push(opts.splice(idx,1)[0].label); }
      value = values;
    } else if (strategy === 'address') {
      const country = text(o.country || 'US').toUpperCase(); const fixture = choice(ADDRESSES[country] || ADDRESSES.US);
      // Match the canonical key order emitted by FP.readAddressParts so existing
      // structured-value verification remains stable regardless of which parts had
      // values during recording. The runtime adapter maps `province` to the live UI.
      value = {
        street: fixture.street,
        city: fixture.city,
        province: fixture.state || fixture.province || '',
        country: fixture.country,
        postalCode: fixture.postalCode
      };
    } else {
      return {ok:false,error:'This field type does not have a supported randomization strategy yet.'};
    }
    if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return {ok:false,error:'The generator could not produce a non-empty value.'};
    const targetLength = Number(step?.target?.length || step?.target?.maxLength || 0);
    if (targetLength > 0 && typeof value === 'string' && value.length > targetLength) return {ok:false,error:`The generated ${strategy==='email'?'email':strategy==='url'?'URL':strategy==='phone'?'phone number':'text'} is ${value.length} characters, exceeding this field's ${targetLength}-character limit. Adjust the generator or field.`};
    if (cfg.options?.unique && ['email','url'].includes(strategy) && runState.usedValues instanceof Set) {
      const key=`${strategy}:${String(value).toLowerCase()}`;
      if(runState.usedValues.has(key)) {
        if (uniqueRetry < 40) return generate(step, config, runState, uniqueRetry + 1);
        return {ok:false,error:'A duplicate sample was generated repeatedly. Try again or adjust the value settings.'};
      }
      runState.usedValues.add(key);
    }
    if (cfg.options?.unique && !['textPrefixUnique','email','url'].includes(strategy) && runState.usedValues instanceof Set && !['numberRange','numberRangeIncrement','currencyRange','percentRange'].includes(strategy)) {
      const key=`${strategy}:${typeof value==='object'?JSON.stringify(value):String(value).toLowerCase()}`;
      if(runState.usedValues.has(key)) {
        if (uniqueRetry < 40) return generate(step, config, runState, uniqueRetry + 1);
        return {ok:false,error:'A unique sample could not be generated. Use a larger value pool or turn off uniqueness.'};
      }
      runState.usedValues.add(key);
    }
    return {ok:true,value,metaPatch,strategy};
  };

  root.ForcePilotRandomizer = Object.freeze({ VERSION:1, fieldType, guessStrategy, strategies, defaults, validate, generate, validOptions, allowedOptions, randomId });
})(typeof self !== 'undefined' ? self : globalThis);
