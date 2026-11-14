/**
 * Generated from docs/openapi.json (OpenAPI 3.1.0 - Apartment Association Platform v0.1.0)
 * Handed-over backend commit: ebe1eb3
 */

export type AnswerMode = 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'OWN_VALUE'
export type AuthMethod = 'MAGIC_LINK' | 'PASSWORD' | 'REGISTRATION'
export type BuildingRole = 'CHAIRMAN' | 'BOARD' | 'ACCOUNTANT' | 'USER'
export type Channel = 'in_app' | 'email' | 'telegram' | 'webpush'
export type DeviceKind = 'DESKTOP_BROWSER' | 'MOBILE_BROWSER' | 'UNKNOWN'
export type DisplayMode = 'APARTMENT_ONLY' | 'INITIALS' | 'FULL_NAME'
export type Eligibility = 'RESIDENTS' | 'OWNERS'
export type InvitationKind = 'OWNER' | 'TENANT' | 'STAFF'
export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'NO_LONGER_VALID'
export type Locale = 'et' | 'ru' | 'en'
export type MeterUnit = 'm3' | 'kWh' | 'MWh'
export type NotificationEventType =
  | 'EMERGENCY_PUBLISHED'
  | 'EMERGENCY_RESOLVED'
  | 'READING_DEADLINE'
  | 'PERIOD_REVIEW'
  | 'APARTMENT_MESSAGE'
  | 'APARTMENT_MESSAGE_TO_BOARD'
  | 'POLL_OPENED'
  | 'ISSUE_REPORTED'
  | 'ISSUE_URGENT'
  | 'ISSUE_STATUS_CHANGED'
  | 'MAINTENANCE_DUE'
  | 'NOTICE_PUBLISHED'
  | 'STORAGE_ALMOST_FULL'
export type PeriodStatus = 'OPEN_FOR_RESIDENTS' | 'REVIEW_BY_BOARD' | 'LOCKED'
export type PollKind = 'INFORMATIVE'
export type PollStatus = 'DRAFT' | 'OPEN' | 'CLOSED' | 'CANCELLED'
export type PollUnit = 'APARTMENT' | 'PERSON'
export type PostCategory = 'GENERAL' | 'WATER_SHUTOFF' | 'MAINTENANCE' | 'MARKETPLACE'
export type PostOrigin = 'MAINTENANCE'
export type PostType =
  | 'EMERGENCY'
  | 'OFFICIAL_NOTICE'
  | 'FORUM_TOPIC'
  | 'APARTMENT_THREAD'
  | 'BOARD_TOPIC'
export type ReadingSource = 'RESIDENT' | 'ADMIN_OVERRIDE' | 'AUTO_ESTIMATED' | 'IOT_WEBHOOK'
export type RelationType = 'OWNER' | 'TENANT' | 'RESIDENT'
export type ResourceType = 'COLD_WATER' | 'HOT_WATER' | 'ELECTRICITY' | 'HEAT' | 'GAS'
export type RoleBadge = 'OWNER' | 'RESIDENT' | 'BOARD' | 'ACCOUNTANT'
export type SignInStatus = 'SIGNED_IN' | 'REGISTRATION_REQUIRED' | 'SIGN_IN_TO_ACCEPT'
export type StaffRole = 'BOARD' | 'ACCOUNTANT' | 'CHAIRMAN'
export type SubjectType = 'post' | 'period' | 'poll' | 'issue' | 'maintenance_task' | 'storage'
export type SubmissionStatus = 'SUBMITTED' | 'MISSING' | 'AUTO_ESTIMATED' | 'ANOMALY_CONFIRMED'
export type TargetScope = 'ALL_BUILDING' | 'ENTRANCE' | 'APARTMENT_LIST'
export type UnavailableReason = 'DEMO_MODE' | 'CHANNEL_NOT_ENABLED' | 'NO_EMAIL' | 'NOT_LINKED'
export type ValueType = 'TEXT' | 'NUMBER' | 'DATE'

export interface AuthorBadgeDTO {
  display_label: string
  role_badge: RoleBadge
}

export interface ValidationErrorItem {
  loc: Array<string | number>
  message: string
  type: string
}

export interface ErrorResponse {
  error_code: string
  message: string
  errors?: ValidationErrorItem[] | null
  trace_id?: string | null
  [key: string]: unknown
}

export interface DemoUserView {
  user_id: string
  label: string
  building_role: BuildingRole
  apartment_number: string | null
  relation_type: RelationType | null
}

export interface BuildingResponse {
  building_id: string
  id?: string
  name: string
  registry_code: string | null
  address: string
  country_code?: string
  reading_deadline_day?: number
  district?: string | null
  apartment_count?: number
  apartments_count?: number
  total_apartments?: number
  entrance_count?: number
  entrances_count?: number
  total_entrances?: number
  heated_area_m2: string
  total_area_m2?: string
}

export interface MembershipView {
  membership_id: string
  apartment_id: string
  apartment_number: string
  entrance: number
  floor: number
  relation_type: RelationType
  can_submit_readings: boolean
  can_view_bills: boolean
  can_vote: boolean
  privacy_display_mode: DisplayMode
  since: string
  preview_badge: AuthorBadgeDTO
}

export interface MeResponse {
  user_id: string
  building_id: string
  building_role: BuildingRole
  privacy_display_mode: DisplayMode
  locale: Locale | null
  memberships: MembershipView[]
}

export interface LocaleUpdate {
  locale: Locale | null
}

export interface PrivacyUpdateRequest {
  privacy_display_mode: DisplayMode
}

export interface PrivacyUpdateResponse {
  membership_id: string
  privacy_display_mode: DisplayMode
  preview_badge: AuthorBadgeDTO
}

export interface ApartmentSummary {
  apartment_id: string
  apartment_number: string
  entrance: number
  floor: number
  area_m2: string
  owner_count: number
  tenant_count: number
  resident_count: number
}

export interface ApartmentListResponse {
  apartments: ApartmentSummary[]
}

export interface CardResident {
  relation_type: RelationType
  since: string
}

export interface ApartmentCard extends ApartmentSummary {
  residents: CardResident[]
}

export interface ApartmentReading {
  period_code: string
  reading_id: string
  value: string
  consumption_delta: string
  source: ReadingSource
  is_anomaly_confirmed: boolean
}

export interface ApartmentMeterHistory {
  meter_id: string
  resource_type: ResourceType
  serial_number: string
  location_label: string
  unit: MeterUnit
  is_active: boolean
  readings: ApartmentReading[]
}

export interface ApartmentReadingsResponse {
  apartment_id: string
  apartment_number: string
  periods: PeriodDTO[]
  meters: ApartmentMeterHistory[]
}

export interface ApartmentConsumptionMonth {
  period_code: string
  consumption: string | null
  estimated: boolean
}

export interface ApartmentConsumptionSeries {
  resource_type: ResourceType
  unit: MeterUnit
  months: ApartmentConsumptionMonth[]
}

export interface ApartmentConsumptionResponse {
  apartment_id: string
  apartment_number: string
  periods: PeriodDTO[]
  resources: ApartmentConsumptionSeries[]
}

export interface BuildingConsumptionMonth {
  period_code: string
  total: string | null
  apartments_counted: number
  average_per_apartment: string | null
  average_per_m2: string | null
  estimated_readings: number
}

export interface BuildingConsumptionSeries {
  resource_type: ResourceType
  unit: MeterUnit
  months: BuildingConsumptionMonth[]
}

export interface BuildingConsumptionResponse {
  periods: PeriodDTO[]
  resources: BuildingConsumptionSeries[]
}

export interface MagicLinkRequest {
  email: string
}

export interface MagicLinkAccepted {
  accepted?: boolean
}

export interface RedeemRequest {
  token: string
}

export interface SessionResponse {
  access_token: string
  token_type?: string
  expires_in: number
  session_id: string
}

export interface InvitationPreview {
  kind: InvitationKind
  apartment_number: string | null
  building_role: StaffRole | null
}

export interface SignInResponse {
  status: SignInStatus
  session?: SessionResponse | null
  registration_token?: string | null
  expires_in?: number | null
  invitation?: InvitationPreview | null
}

export interface SessionView {
  session_id: string
  device_kind: DeviceKind
  auth_method: AuthMethod
  authenticated_at: string
  last_used_at: string
  current: boolean
}

export interface AcceptRequest {
  token: string
}

export interface AcceptResponse {
  applied: boolean
}

export interface RegistrationRequest {
  registration_token: string
  full_name: string
  phone?: string | null
  locale: Locale
  privacy_display_mode?: DisplayMode
}

export interface PasswordLoginRequest {
  email: string
  password: string
}

export interface PasswordStatus {
  is_set: boolean
}

export interface PasswordUpdate {
  new_password: string
  current_password?: string | null
}

export interface PasswordRemove {
  current_password?: string | null
}

export interface InvitationView {
  invitation_id: string
  kind: InvitationKind
  email: string
  apartment_id: string | null
  apartment_number: string | null
  building_role: StaffRole | null
  status: InvitationStatus
  mine: boolean
  created_at: string
  expires_at: string
}

export interface OwnerInvitationCreate {
  kind: 'OWNER'
  email: string
  apartment_number: string
}

export interface TenantInvitationCreate {
  kind: 'TENANT'
  email: string
  apartment_id: string
}

export interface StaffInvitationCreate {
  kind: 'STAFF'
  email: string
  building_role: StaffRole
}

export interface ReplaceTenantRequest {
  email: string
}

export interface ResidentView {
  user_id: string
  membership_id: string
  relation_type: RelationType
  display_label: string
  since: string
  invited_email: string | null
}

export interface ResidentsResponse {
  residents: ResidentView[]
  pending_invitations: InvitationView[]
}

export interface PersonMembershipView {
  membership_id: string
  apartment_id: string
  apartment_number: string
  relation_type: RelationType
  display_label: string
  since: string
  invited_email: string | null
}

export interface PersonView {
  user_id: string
  is_me: boolean
  display_label: string
  building_role: BuildingRole
  invited_email: string | null
  memberships: PersonMembershipView[]
}

export interface PeopleResponse {
  people: PersonView[]
}

export interface RoleUpdate {
  building_role: BuildingRole
}

export interface RoleUpdateResponse {
  user_id: string
  building_role: BuildingRole
  account_closed: boolean
}

export interface NotificationView {
  id: string
  event_type: NotificationEventType
  subject_type: SubjectType
  subject_id: string
  params: Record<string, unknown>
  created_at: string
  read_at: string | null
}

export interface UnreadCountResponse {
  unread: number
}

export interface ReadResponse {
  id: string
  read_at: string
}

export interface ReadAllResponse {
  updated: number
}

export interface ChannelAvailability {
  channel: Channel
  available: boolean
  reason?: UnavailableReason | null
}

export interface PreferenceView {
  event_type: NotificationEventType
  channel: Channel
  enabled: boolean
  mandatory: boolean
}

export interface PreferencesResponse {
  channels: ChannelAvailability[]
  preferences: PreferenceView[]
}

export interface PreferenceChange {
  event_type: NotificationEventType
  channel: Channel
  enabled: boolean
}

export interface PreferencesUpdateRequest {
  preferences: PreferenceChange[]
}

export interface UnsubscribeResponse {
  event_type: NotificationEventType
  channel: Channel
}

export interface LinkCodeResponse {
  code: string
  expires_at: string
  deep_link: string
}

export interface VapidPublicKeyResponse {
  public_key: string
}

export interface WebPushKeys {
  p256dh: string
  auth: string
}

export interface WebPushSubscriptionRequest {
  endpoint: string
  keys: WebPushKeys
  label: string
}

export interface BindingView {
  binding_id: string
  channel: Channel
  label: string | null
  created_at: string
}

export interface PeriodDTO {
  period_code: string
  status: PeriodStatus
  due_date: string
}

export interface PeriodListResponse {
  periods: PeriodDTO[]
}

export interface ReadingSummary {
  reading_id: string
  value: string
  consumption_delta: string
  source: ReadingSource
  is_anomaly_confirmed: boolean
}

export interface NextSubmission {
  period_code: string
  due_date: string
  final: boolean
  previous_value: string
  average_delta: string | null
  reading: ReadingSummary | null
}

export interface DashboardMeter {
  meter_id: string
  resource_type: ResourceType
  serial_number: string
  location_label: string
  unit: MeterUnit
  previous_value: string
  previous_delta: string | null
  average_delta: string | null
  reading: ReadingSummary | null
  next_submission: NextSubmission | null
}

export interface DashboardApartment {
  apartment_id: string
  apartment_number: string
  can_submit_readings: boolean
  meters: DashboardMeter[]
}

export interface DashboardResponse {
  period: PeriodDTO | null
  apartments: DashboardApartment[]
}

export interface ReadingSubmitRequest {
  meter_id: string
  period_code: string
  value: string
  confirmation_level?: number
  reason?: string | null
}

export interface ReadingResponse {
  reading_id: string
  meter_id: string
  period_code: string
  value: string
  consumption_delta: string
  source: ReadingSource
  is_anomaly_confirmed: boolean
}

export interface HistoryEntry {
  changed_at: string
  old_value: string | null
  new_value: string
  source: ReadingSource
  reason: string | null
  changed_by: AuthorBadgeDTO | null
}

export interface ReadingHistoryResponse {
  reading_id: string
  meter_id: string
  period_code: string
  entries: HistoryEntry[]
}

export interface ResourceBalance {
  resource_type: ResourceType
  unit: MeterUnit
  master_total: string | null
  apartments_sum: string
  unallocated_loss: string | null
}

export interface MasterMeterRow {
  meter_id: string
  resource_type: ResourceType
  location_label: string
  unit: MeterUnit
  previous_value: string
  status: SubmissionStatus
  reading: ReadingSummary | null
}

export interface MatrixMeter {
  meter_id: string
  resource_type: ResourceType
  location_label: string
  unit: MeterUnit
  status: SubmissionStatus
  reading: ReadingSummary | null
}

export interface MatrixApartment {
  apartment_id: string
  apartment_number: string
  entrance: number
  floor: number
  status: SubmissionStatus
  meters: MatrixMeter[]
}

export interface MatrixResponse {
  period: PeriodDTO
  balances: ResourceBalance[]
  master_meters: MasterMeterRow[]
  apartments: MatrixApartment[]
}

export interface EstimatedReading {
  reading_id: string
  meter_id: string
  apartment_id: string
  value: string
  consumption_delta: string
}

export interface EstimateResponse {
  period_code: string
  estimated_count: number
  estimated: EstimatedReading[]
}

export interface PeriodStatusUpdateRequest {
  status: PeriodStatus
}

export interface PeriodStatusUpdateResponse {
  period_code: string
  previous_status: PeriodStatus
  status: PeriodStatus
}

export interface EmergencyView {
  id: string
  post_type: PostType
  category: PostCategory
  title: string
  body: string
  author_badge: AuthorBadgeDTO
  is_mine: boolean
  target_scope: TargetScope
  target_entrance: number | null
  target_apartment_ids: string[] | null
  is_active: boolean
  comments_enabled: boolean
  comments_count: number
  created_at: string
  last_activity_at: string
  acknowledged_at: string | null
  origin?: PostOrigin | null
  edited_at: string | null
  hidden_at: string | null
  hidden_reason: string | null
}

export interface AcknowledgeResponse {
  post_id: string
  acknowledged_at: string
}

export interface ResolveResponse {
  post_id: string
  is_active: boolean
}

export interface PostView {
  id: string
  post_type: PostType
  category: PostCategory
  title: string
  body: string
  author_badge: AuthorBadgeDTO
  is_mine: boolean
  target_scope: TargetScope
  target_entrance: number | null
  target_apartment_ids: string[] | null
  is_active: boolean
  comments_enabled: boolean
  comments_count: number
  created_at: string
  last_activity_at: string
  origin?: PostOrigin | null
  edited_at: string | null
  hidden_at: string | null
  hidden_reason: string | null
}

export interface CommentView {
  id: string
  post_id: string
  body: string | null
  author_badge: AuthorBadgeDTO
  is_mine: boolean
  created_at: string
  edited_at: string | null
  hidden_at: string | null
  hidden_reason: string | null
}

export interface PostDetail extends PostView {
  comments: CommentView[]
}

export interface PostCreateRequest {
  post_type: PostType
  category?: PostCategory
  title: string
  body: string
  target_scope?: TargetScope
  target_entrance?: number | null
  target_apartment_ids?: string[] | null
  comments_enabled?: boolean
  author_apartment_id?: string | null
}

export interface CommentCreateRequest {
  body: string
  author_apartment_id?: string | null
}

export interface HideRequest {
  reason: string
}

export interface PostEditRequest {
  title?: string
  body?: string
}

export interface CommentEditRequest {
  body: string
}

export interface components {
  schemas: {
    AcceptRequest: AcceptRequest
    AcceptResponse: AcceptResponse
    AcknowledgeResponse: AcknowledgeResponse
    ApartmentCard: ApartmentCard
    ApartmentListResponse: ApartmentListResponse
    ApartmentMeterHistory: ApartmentMeterHistory
    ApartmentReading: ApartmentReading
    ApartmentReadingsResponse: ApartmentReadingsResponse
    ApartmentSummary: ApartmentSummary
    AuthMethod: AuthMethod
    AuthorBadgeDTO: AuthorBadgeDTO
    BindingView: BindingView
    BuildingResponse: BuildingResponse
    BuildingRole: BuildingRole
    CardResident: CardResident
    Channel: Channel
    ChannelAvailability: ChannelAvailability
    CommentCreateRequest: CommentCreateRequest
    CommentView: CommentView
    DashboardApartment: DashboardApartment
    DashboardMeter: DashboardMeter
    DashboardResponse: DashboardResponse
    DemoUserView: DemoUserView
    DeviceKind: DeviceKind
    DisplayMode: DisplayMode
    EmergencyView: EmergencyView
    ErrorResponse: ErrorResponse
    EstimateResponse: EstimateResponse
    EstimatedReading: EstimatedReading
    HideRequest: HideRequest
    HistoryEntry: HistoryEntry
    InvitationKind: InvitationKind
    InvitationPreview: InvitationPreview
    InvitationStatus: InvitationStatus
    InvitationView: InvitationView
    LinkCodeResponse: LinkCodeResponse
    Locale: Locale
    LocaleUpdate: LocaleUpdate
    MagicLinkAccepted: MagicLinkAccepted
    MagicLinkRequest: MagicLinkRequest
    MasterMeterRow: MasterMeterRow
    MatrixApartment: MatrixApartment
    MatrixMeter: MatrixMeter
    MatrixResponse: MatrixResponse
    MeResponse: MeResponse
    MembershipView: MembershipView
    MeterUnit: MeterUnit
    NextSubmission: NextSubmission
    NotificationEventType: NotificationEventType
    NotificationView: NotificationView
    OwnerInvitationCreate: OwnerInvitationCreate
    PasswordLoginRequest: PasswordLoginRequest
    PasswordRemove: PasswordRemove
    PasswordStatus: PasswordStatus
    PasswordUpdate: PasswordUpdate
    PeopleResponse: PeopleResponse
    PeriodDTO: PeriodDTO
    PeriodListResponse: PeriodListResponse
    PeriodStatus: PeriodStatus
    PeriodStatusUpdateRequest: PeriodStatusUpdateRequest
    PeriodStatusUpdateResponse: PeriodStatusUpdateResponse
    PersonMembershipView: PersonMembershipView
    PersonView: PersonView
    PostCategory: PostCategory
    PostCreateRequest: PostCreateRequest
    PostDetail: PostDetail
    PostType: PostType
    PostView: PostView
    PreferenceChange: PreferenceChange
    PreferenceView: PreferenceView
    PreferencesResponse: PreferencesResponse
    PreferencesUpdateRequest: PreferencesUpdateRequest
    PrivacyUpdateRequest: PrivacyUpdateRequest
    PrivacyUpdateResponse: PrivacyUpdateResponse
    ReadAllResponse: ReadAllResponse
    ReadResponse: ReadResponse
    ReadingHistoryResponse: ReadingHistoryResponse
    ReadingResponse: ReadingResponse
    ReadingSource: ReadingSource
    ReadingSubmitRequest: ReadingSubmitRequest
    ReadingSummary: ReadingSummary
    RedeemRequest: RedeemRequest
    RegistrationRequest: RegistrationRequest
    RelationType: RelationType
    ReplaceTenantRequest: ReplaceTenantRequest
    ResidentView: ResidentView
    ResidentsResponse: ResidentsResponse
    ResolveResponse: ResolveResponse
    ResourceBalance: ResourceBalance
    ResourceType: ResourceType
    RoleBadge: RoleBadge
    RoleUpdate: RoleUpdate
    RoleUpdateResponse: RoleUpdateResponse
    SessionResponse: SessionResponse
    SessionView: SessionView
    SignInResponse: SignInResponse
    SignInStatus: SignInStatus
    StaffInvitationCreate: StaffInvitationCreate
    StaffRole: StaffRole
    SubjectType: SubjectType
    SubmissionStatus: SubmissionStatus
    TargetScope: TargetScope
    TenantInvitationCreate: TenantInvitationCreate
    UnavailableReason: UnavailableReason
    UnreadCountResponse: UnreadCountResponse
    UnsubscribeResponse: UnsubscribeResponse
    ValidationErrorItem: ValidationErrorItem
    VapidPublicKeyResponse: VapidPublicKeyResponse
    WebPushKeys: WebPushKeys
    WebPushSubscriptionRequest: WebPushSubscriptionRequest
    AnswerInput: AnswerInput
    AnswerMode: AnswerMode
    AnswerView: AnswerView
    BallotRequest: BallotRequest
    BallotView: BallotView
    DeadlineUpdate: DeadlineUpdate
    Eligibility: Eligibility
    NumberResult: NumberResult
    OptionResult: OptionResult
    OptionView: OptionView
    Participation: Participation
    PollDraftRequest: PollDraftRequest
    PollKind: PollKind
    PollResults: PollResults
    PollStatus: PollStatus
    PollSummary: PollSummary
    PollUnit: PollUnit
    PollView: PollView
    QuestionDraft: QuestionDraft
    QuestionResult: QuestionResult
    QuestionView: QuestionView
    ValueCountResult: ValueCountResult
    ValueType: ValueType
    SettingType: SettingType
    SettingView: SettingView
    SettingsUpdate: SettingsUpdate
    SettingsView: SettingsView
    BoardStatus: BoardStatus
    IssueAction: IssueAction
    IssueCategory: IssueCategory
    IssueEdit: IssueEdit
    IssueForm: IssueForm
    IssuePhoto: IssuePhoto
    IssueReport: IssueReport
    IssueStatus: IssueStatus
    IssueSummary: IssueSummary
    IssueView: IssueView
    PhotoVariant: PhotoVariant
    ReporterView: ReporterView
    StatusChange: StatusChange
    StatusFilter: StatusFilter
    TimelineEntry: TimelineEntry
    CategoryUsage: CategoryUsage
    FileUsage: FileUsage
  }
}

export interface OptionView {
  id: string
  position: number
  value: string
}

export interface QuestionView {
  id: string
  position: number
  text: string
  prompt?: string
  answer_mode: AnswerMode
  value_type: ValueType
  required: boolean
  min_choices?: number | null
  max_choices?: number | null
  min_value?: string | null
  max_value?: string | null
  options: OptionView[]
}

export interface AnswerView {
  question_id: string
  option_ids: string[]
  value?: string | null
}

export interface BallotView {
  apartment_id?: string | null
  submitted_at?: string
  updated_at: string
  answers: AnswerView[]
}

export interface PollSummary {
  id: string
  kind: PollKind
  title: string
  description: string
  status: PollStatus
  target_scope: TargetScope
  target_entrance?: number | null
  target_apartment_ids?: string[] | null
  eligibility: Eligibility
  unit: PollUnit
  closes_at: string
  opened_at?: string | null
  closed_at?: string | null
  cancelled_at?: string | null
  created_at: string
  results_available: boolean
  can_answer: boolean
  answerable_apartment_ids: string[]
  answered: boolean
}

export interface PollView {
  id: string
  kind: PollKind
  title: string
  description: string
  status: PollStatus
  target_scope: TargetScope
  target_entrance?: number | null
  target_apartment_ids?: string[] | null
  eligibility: Eligibility
  unit: PollUnit
  closes_at: string
  opened_at?: string | null
  closed_at?: string | null
  cancelled_at?: string | null
  created_at: string
  results_available: boolean
  can_answer: boolean
  answerable_apartment_ids: string[]
  questions: QuestionView[]
  my_ballots: BallotView[]
}

export interface AnswerInput {
  question_id: string
  option_ids?: string[]
  value?: string | null
}

export interface BallotRequest {
  apartment_id?: string | null
  answers: AnswerInput[]
}

export interface QuestionDraft {
  text: string
  answer_mode: AnswerMode
  value_type: ValueType
  required?: boolean
  min_choices?: number | null
  max_choices?: number | null
  min_value?: string | null
  max_value?: string | null
  options?: string[]
}

export interface PollDraftRequest {
  title: string
  description?: string
  target_scope?: TargetScope
  target_entrance?: number | null
  target_apartment_ids?: string[] | null
  eligibility?: Eligibility
  unit?: PollUnit
  closes_at: string
  questions: QuestionDraft[]
}

export interface DeadlineUpdate {
  closes_at: string
}

export interface Participation {
  answered: number
  electorate: number
}

export interface OptionResult {
  option_id: string
  count: number
}

export interface NumberResult {
  min: string
  max: string
  average: string
}

export interface ValueCountResult {
  value: string
  count: number
}

export interface QuestionResult {
  question_id: string
  answered: number
  options?: OptionResult[] | null
  number?: NumberResult | null
  dates?: ValueCountResult[] | null
  texts?: ValueCountResult[] | null
}

export interface PollResults {
  poll_id: string
  status: PollStatus
  unit: PollUnit
  participation: Participation
  questions: QuestionResult[]
}

export type SettingType = 'INTEGER' | 'BOOLEAN'

export interface SettingView {
  key: string
  type: SettingType
  value: number | boolean
  default: number | boolean
  minimum: number | null
  maximum: number | null
  is_default: boolean
  updated_at: string | null
}

export interface SettingsUpdate {
  values: Record<string, boolean | number | null>
}

export interface SettingsView {
  settings: SettingView[]
}

export type IssueCategory =
  | 'LIGHTING'
  | 'DOORS_AND_LOCKS'
  | 'LIFT'
  | 'HEATING'
  | 'WATER_AND_SEWAGE'
  | 'ELECTRICITY'
  | 'CLEANING'
  | 'WASTE'
  | 'YARD'
  | 'ROOF_AND_FACADE'
  | 'OTHER'

export type IssueStatus =
  | 'REPORTED'
  | 'IN_PROGRESS'
  | 'WAITING_FOR_CONTRACTOR'
  | 'RESOLVED'
  | 'DUPLICATE'
  | 'DECLINED'
  | 'WITHDRAWN'

export type StatusFilter = 'OPEN' | 'ENDED' | IssueStatus

export type BoardStatus =
  | 'IN_PROGRESS'
  | 'WAITING_FOR_CONTRACTOR'
  | 'RESOLVED'
  | 'DUPLICATE'
  | 'DECLINED'

export type IssueAction = 'STATUS' | 'URGENT_CLEARED'

export interface IssueForm {
  urgent_enabled: boolean
  uploads_enabled?: boolean
  apartment_ids: string[]
  entrances: number[]
}

export interface IssueReport {
  category: IssueCategory
  entrance?: number | null
  place?: string | null
  title: string
  description?: string
  urgent?: boolean
  apartment_id?: string | null
}

export interface IssueEdit {
  category?: IssueCategory | null
  entrance?: number | null
  place?: string | null
  title?: string | null
  description?: string | null
}

export interface ReporterView {
  badge: AuthorBadgeDTO
  apartment_id: string | null
}

export interface TimelineEntry {
  status: IssueStatus
  at: string
  action?: IssueAction
  changed_by?: AuthorBadgeDTO | null
}

export type PhotoVariant = 'thumb' | 'display'

export interface IssuePhoto {
  id: string
  width: number | null
  height: number | null
  created_at: string
  mine: boolean
  can_delete: boolean
}

export interface IssueSummary {
  id: string
  category: IssueCategory
  entrance: number | null
  place: string | null
  title: string
  status: IssueStatus
  urgent: boolean
  followers: number
  i_follow: boolean
  i_reported: boolean
  can_follow: boolean
  can_edit: boolean
  can_manage?: boolean
  duplicate_of: string | null
  created_at: string
  updated_at: string
  ended_at: string | null
  photos?: IssuePhoto[]
  can_add_photo?: boolean
  photos_delete_at?: string | null
}

export interface IssueView extends IssueSummary {
  description: string
  reporter: ReporterView | null
  timeline: TimelineEntry[]
  photos: IssuePhoto[]
  can_add_photo: boolean
  photos_delete_at: string | null
}

export interface StatusChange {
  status: BoardStatus
  duplicate_of?: string | null
}

export type PeriodUnit = 'DAY' | 'MONTH' | 'YEAR'
export type TaskStatus = 'ACTIVE' | 'PAUSED' | 'ARCHIVED'
export type OccurrenceState = 'UPCOMING' | 'DUE' | 'OVERDUE' | 'PAUSED'

export interface NoticeDraft {
  title: string
  body: string
  category: PostCategory
  target_scope: TargetScope
  target_entrance: number | null
  target_apartment_ids: string[] | null
  comments_enabled: boolean
}

export interface CurrentOccurrence {
  occurrence_id: string
  due_date: string
  publish_on: string
  state: OccurrenceState
  published_at: string | null
  board_post_id: string | null
  notice_post_id: string | null
  notice_failed: boolean
  reminder_count: number
}

export interface TaskView {
  id: string
  title: string
  instructions: string
  period_unit: PeriodUnit
  period_count: number
  lead_days: number
  anchor_date: string
  status: TaskStatus
  notice: NoticeDraft | null
  current: CurrentOccurrence | null
  last_closed_on: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface TaskCreate {
  title: string
  instructions?: string
  period_unit: PeriodUnit
  period_count: number
  lead_days: number
  first_due_date: string
  notice?: NoticeDraft | null
}

export interface TaskEdit {
  title?: string
  instructions?: string
  lead_days?: number
  notice?: NoticeDraft | null
  period_unit?: PeriodUnit
  period_count?: number
  next_due_date?: string
  occurrence_id?: string
}

export interface TaskResume {
  next_due_date?: string
  occurrence_id?: string
}

export type LogKind = 'DONE' | 'SKIPPED'

export interface DoneRequest {
  occurrence_id: string
  done_on: string
  note?: string | null
  cost?: string | null
}

export interface SkipRequest {
  occurrence_id: string
  note: string
}

export interface LogEntryView {
  id: string
  task_id: string
  task_title: string
  kind: LogKind
  planned_date: string
  closed_on: string
  note: string
  cost: string | null
  recorded_by: AuthorBadgeDTO
  recorded_at: string
  updated_at: string
  updated_by: AuthorBadgeDTO | null
}

export interface LogEdit {
  note?: string | null
  cost?: string | null
}

export interface ClosedOccurrence {
  entry: LogEntryView
  task: TaskView
}

export interface TaskReport {
  task_id: string
  task_title: string
  done_count: number
  skipped_count: number
  total_cost: string
}

export interface YearReport {
  year: number
  done_count: number
  skipped_count: number
  total_cost: string
  tasks: TaskReport[]
}

export type DocumentCategory =
  | 'ARTICLES'
  | 'GENERAL_MEETING_MINUTES'
  | 'BOARD_MINUTES'
  | 'CONTRACT'
  | 'INVOICE'
  | 'FINANCIAL_REPORT'
  | 'INSURANCE'
  | 'HOUSE_RULES'
  | 'OTHER'

export type DocumentAudience = 'EVERYONE' | 'BOARD_AND_ACCOUNTANT' | 'BOARD'

export interface DocumentView {
  id: string
  title: string
  category: DocumentCategory | string
  audience: DocumentAudience
  document_date: string | null
  size_bytes: number
  created_at: string
  updated_at: string
  mine: boolean
  can_edit: boolean
  can_delete: boolean
  uploaded_by: AuthorBadgeDTO | null
}

export interface DocumentUploadOptions {
  can_upload: boolean
  audiences: DocumentAudience[]
  categories: Array<DocumentCategory | string>
  max_bytes: number
}

export interface DocumentEdit {
  title?: string
  category?: DocumentCategory | string
  audience?: DocumentAudience
  document_date?: string | null
}

export interface CategoryUsage {
  category: string
  used_bytes: number
  limit_bytes: number
}

export interface FileUsage {
  quota_bytes: number
  used_bytes: number
  used_percent: number
  pending_deletion_bytes: number
  categories: CategoryUsage[]
}



