import { describe, expect, it } from 'vitest';
import { normalizeListFilters, normalizeTicketRef, ticketKeys } from './keys';
import {
  NEW_TICKET_ERRORS as E,
  buildNewTicketSchema,
  countFieldErrors,
  customFieldsPayload,
  dropUnavailableOptions,
  effectivePriority,
  emptyNewTicketValues,
  securityCategory,
  toCreateTicketInput,
  type NewTicketFormValues,
} from './new-ticket-form';
import { BUSINESS_DAY_MINUTES, slaWindowParts } from './sla-format';
import { FORM_CONFIG, IDS } from './test-fixtures';

const valid = (overrides: Partial<NewTicketFormValues> = {}): NewTicketFormValues =>
  emptyNewTicketValues({
    subject: 'Cameras not recording',
    categoryId: IDS.cctv,
    subtypeId: IDS.cameraOffline,
    siteId: IDS.siteA,
    description: 'Nothing recorded since 06:40.',
    ...overrides,
  });

function issues(values: NewTicketFormValues, requireRequester = false, siteIds?: string[]) {
  const schema = buildNewTicketSchema(FORM_CONFIG, {
    requireRequester,
    categoryId: values.categoryId,
    type: values.type,
    siteIds,
  });
  const result = schema.safeParse(values);
  return result.success
    ? {}
    : Object.fromEntries(result.error.issues.map((i) => [i.path.join('.'), i.message]));
}

describe('new ticket schema', () => {
  it('accepts a complete ticket', () => {
    expect(issues(valid())).toEqual({});
  });

  it('reports every missing field with the design messages (contract keys for subject/description)', () => {
    expect(issues(emptyNewTicketValues(), true)).toEqual({
      requesterId: E.requesterRequired,
      subject: 'validation.subjectRequired',
      categoryId: E.categoryRequired,
      subtypeId: E.subtypeNeedsCategory,
      siteId: E.siteRequired,
      description: 'validation.descriptionMin',
    });
  });

  it('asks for a sub-type of the chosen category', () => {
    expect(issues(valid({ subtypeId: '' }))).toEqual({ subtypeId: E.subtypeRequired });
    // A sub-type of another category is not accepted.
    expect(issues(valid({ subtypeId: IDS.secAlert }))).toEqual({ subtypeId: E.subtypeRequired });
  });

  it('forces the security category for Security Incident tickets', () => {
    expect(issues(valid({ type: 'SECURITY_INCIDENT' }))).toEqual({
      categoryId: E.securityCategory,
    });
    expect(
      issues(valid({ type: 'SECURITY_INCIDENT', categoryId: IDS.cyber, subtypeId: IDS.phishing })),
    ).toEqual({});
    expect(securityCategory(FORM_CONFIG)?.id).toBe(IDS.cyber);
  });

  it('checks the site against the requester organisation when known', () => {
    expect(issues(valid(), false, [IDS.siteB])).toEqual({ siteId: E.siteRequired });
    expect(issues(valid({ siteId: IDS.siteB }), false, [IDS.siteB])).toEqual({});
  });

  it('validates typed and required custom fields of the category only', () => {
    const lab = valid({ categoryId: IDS.lab, subtypeId: IDS.labSub });
    expect(issues(lab)).toEqual({
      'customFields.room': E.fieldRequired,
      'customFields.vendor': E.fieldRequired,
      'customFields.on_site': E.fieldRequired,
    });
    expect(
      issues({
        ...lab,
        customFields: {
          room: 'Room 2.14',
          vendor: 'nope',
          on_site: false,
          floors: 'three',
          since: '2026-13-45',
          zones: ['a', 'x'],
          // A field of another category is ignored.
          camera_id: 42 as never,
        },
      }),
    ).toEqual({
      'customFields.vendor': E.optionInvalid,
      'customFields.floors': E.numberInvalid,
      'customFields.since': E.dateInvalid,
      'customFields.zones': E.optionInvalid,
    });
    expect(
      issues({
        ...lab,
        customFields: {
          room: 'Room 2.14',
          vendor: 'axis',
          on_site: true,
          floors: '3',
          since: '2026-09-01',
          zones: ['a'],
        },
      }),
    ).toEqual({});
  });

  it('caps text lengths like the contract', () => {
    expect(issues(valid({ subject: 'x'.repeat(201) }))).toEqual({
      subject: 'validation.tooLong',
    });
    expect(issues(valid({ assetId: 'x'.repeat(101) }))).toEqual({ assetId: E.tooLong });
  });
});

describe('priority', () => {
  it('uses the manual priority, else the sub-type default', () => {
    expect(effectivePriority(valid(), FORM_CONFIG)).toBe('P2');
    expect(effectivePriority(valid({ subtypeId: IDS.nvrFailure }), FORM_CONFIG)).toBe('P1');
    expect(effectivePriority(valid({ priority: 'P4' }), FORM_CONFIG)).toBe('P4');
    expect(effectivePriority(valid({ subtypeId: '' }), FORM_CONFIG)).toBeNull();
  });
});

describe('POST /tickets body', () => {
  it('sends the priority only when set manually, and the requester only for staff', () => {
    const client = toCreateTicketInput(valid({ assetId: '  CAM-014 ' }), {
      config: FORM_CONFIG,
      isStaff: false,
      attachmentIds: [],
    });
    expect(client).toEqual({
      type: 'INCIDENT',
      categoryId: IDS.cctv,
      subtypeId: IDS.cameraOffline,
      impact: 'SINGLE_USER',
      siteId: IDS.siteA,
      assetId: 'CAM-014',
      subject: 'Cameras not recording',
      description: 'Nothing recorded since 06:40.',
      customFields: {},
      attachmentIds: [],
    });

    const staff = toCreateTicketInput(valid({ priority: 'P1', requesterId: IDS.requester }), {
      config: FORM_CONFIG,
      isStaff: true,
      attachmentIds: [IDS.ticket],
    });
    expect(staff.priority).toBe('P1');
    expect(staff.requesterId).toBe(IDS.requester);
    expect(staff.attachmentIds).toEqual([IDS.ticket]);
    expect(staff).not.toHaveProperty('assetId');
  });

  it('types custom fields and leaves empty ones out', () => {
    const lab = FORM_CONFIG.categories.find((c) => c.id === IDS.lab)!;
    expect(
      customFieldsPayload(lab, {
        room: ' Room 2.14 ',
        floors: '3',
        vendor: '',
        zones: [],
        since: '2026-09-01',
        on_site: false,
        camera_id: 'CAM-1',
      }),
    ).toEqual({ room: 'Room 2.14', floors: 3, since: '2026-09-01', on_site: false });
  });

  it('counts field errors (each custom field once)', () => {
    expect(
      countFieldErrors({
        subject: { message: 'x' },
        customFields: { room: { message: 'x' }, vendor: { message: 'y' } },
        root: { message: 'z' },
      }),
    ).toBe(3);
  });
});

describe('keys', () => {
  it('normalises refs and list filters', () => {
    expect(normalizeTicketRef('lg-4817')).toBe('LG-4817');
    expect(normalizeTicketRef('4817')).toBe('LG-4817');
    expect(normalizeTicketRef(IDS.ticket.toUpperCase())).toBe(IDS.ticket);
    expect(ticketKeys.detail('4817')).toEqual(ticketKeys.detail('LG-4817'));
    expect(
      normalizeListFilters({ view: 'open', search: '', sort: undefined, teamId: 'x' }),
    ).toEqual({ teamId: 'x', view: 'open' });
    expect(ticketKeys.list({ sort: 'sla', view: 'mine' })).toEqual(
      ticketKeys.list({ view: 'mine', sort: 'sla' }),
    );
    expect(ticketKeys.list({}).slice(0, 2)).toEqual(ticketKeys.lists());
  });
});

describe('SLA windows', () => {
  it('phrases policy minutes like the design', () => {
    expect(slaWindowParts(15, false)).toEqual({ unit: 'minutes', n: 15 });
    expect(slaWindowParts(60, false)).toEqual({ unit: 'hours', n: 1 });
    expect(slaWindowParts(240, true)).toEqual({ unit: 'hours', n: 4 });
    expect(slaWindowParts(BUSINESS_DAY_MINUTES, true)).toEqual({ unit: 'businessDays', n: 1 });
    expect(slaWindowParts(2 * BUSINESS_DAY_MINUTES, true)).toEqual({
      unit: 'businessDays',
      n: 2,
    });
    expect(slaWindowParts(2880, false)).toEqual({ unit: 'days', n: 2 });
    expect(slaWindowParts(90, false)).toEqual({ unit: 'hoursMinutes', hours: 1, minutes: 30 });
  });
});

describe('dropUnavailableOptions (E18: an option archived while the form is open)', () => {
  const lab = FORM_CONFIG.categories.find((c) => c.key === 'lab')!;
  const archived = lab.fields.map((f) =>
    f.key === 'zones' || f.key === 'vendor'
      ? { ...f, options: f.options.filter((o) => o.value !== 'b' && o.value !== 'hik') }
      : f,
  );

  it('keeps the offered choices and clears the rest, naming the fields', () => {
    const values = { room: 'B-12', vendor: 'hik', zones: ['a', 'b'], on_site: true };
    const result = dropUnavailableOptions(archived, values);
    expect(result.values).toEqual({ room: 'B-12', vendor: '', zones: ['a'], on_site: true });
    expect(result.changed.map((f) => f.key)).toEqual(['vendor', 'zones']);
    expect(values.zones).toEqual(['a', 'b']);
  });

  it('returns the same values when every choice is still offered', () => {
    const values = { vendor: 'axis', zones: ['a'], room: '' };
    const result = dropUnavailableOptions(archived, values);
    expect(result.values).toBe(values);
    expect(result.changed).toEqual([]);
  });
});
