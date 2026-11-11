import DashboardView from '@/views/dashboard/DashboardView.vue'
import ReadingsView from '@/views/readings/ReadingsView.vue'
import AccountingView from '@/views/accounting/AccountingView.vue'
import ForumView from '@/views/forum/ForumView.vue'
import PostDetailView from '@/views/forum/PostDetailView.vue'
import DocumentsView from '@/views/documents/DocumentsView.vue'
import WelcomeView from '@/views/entry/WelcomeView.vue'
import ThemeLabView from '@/views/theme/ThemeLabView.vue'

export const NAV_GROUPS = [
  {
    id: 'home',
    icon: 'space_dashboard',
    labelKey: 'home',
    shortLabelKey: 'home',
  },
  {
    id: 'services',
    icon: 'home_iot_device',
    labelKey: 'services',
    shortLabelKey: 'services',
  },
  {
    id: 'community',
    icon: 'forum',
    labelKey: 'community',
    shortLabelKey: 'community',
  },
  {
    id: 'management',
    icon: 'admin_panel_settings',
    labelKey: 'management',
    shortLabelKey: 'management',
  },
]

export const APP_ROUTES = [
  {
    path: '/',
    name: 'dashboard',
    component: DashboardView,
    meta: {
      layout: 'AppLayout',
      roles: ['USER', 'BOARD', 'CHAIRMAN', 'ACCOUNTANT'],
      navKey: 'dashboard',
      navGroup: 'home',
      icon: 'space_dashboard',
    },
  },
  {
    path: '/readings',
    name: 'readings',
    component: ReadingsView,
    meta: {
      layout: 'AppLayout',
      roles: ['USER', 'BOARD', 'CHAIRMAN', 'ACCOUNTANT'],
      navKey: 'readings',
      navGroup: 'services',
      icon: 'speed',
    },
  },
  {
    path: '/forum',
    name: 'forum',
    component: ForumView,
    meta: {
      layout: 'AppLayout',
      roles: ['USER', 'BOARD', 'CHAIRMAN', 'ACCOUNTANT'],
      navKey: 'forum',
      navGroup: 'community',
      icon: 'forum',
    },
  },
  {
    path: '/forum/:postId',
    name: 'forum-detail',
    component: PostDetailView,
    meta: {
      layout: 'AppLayout',
      roles: ['USER', 'BOARD', 'CHAIRMAN', 'ACCOUNTANT'],
    },
  },
  {
    path: '/messages',
    name: 'messages',
    component: () => import('@/views/messages/MessagesView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['USER', 'BOARD', 'CHAIRMAN', 'ACCOUNTANT'],
      requiresApartmentOrBoard: true,
      navKey: 'messages',
      navGroup: 'community',
      icon: 'mail',
    },
  },
  {
    path: '/messages/:postId',
    name: 'message-thread',
    component: () => import('@/views/messages/MessageThreadView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['USER', 'BOARD', 'CHAIRMAN', 'ACCOUNTANT'],
      requiresApartmentOrBoard: true,
    },
  },
  {
    path: '/polls',
    name: 'polls',
    component: () => import('@/views/polls/PollsView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['USER', 'BOARD', 'CHAIRMAN', 'ACCOUNTANT'],
      navKey: 'polls',
      navGroup: 'community',
      icon: 'how_to_vote',
    },
  },
  {
    path: '/polls/new',
    name: 'poll-new',
    component: () => import('@/views/polls/PollEditorView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['BOARD', 'CHAIRMAN'],
    },
  },
  {
    path: '/polls/:pollId/edit',
    name: 'poll-edit',
    component: () => import('@/views/polls/PollEditorView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['BOARD', 'CHAIRMAN'],
    },
  },
  {
    path: '/polls/:pollId',
    name: 'poll-detail',
    component: () => import('@/views/polls/PollDetailView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['USER', 'BOARD', 'CHAIRMAN', 'ACCOUNTANT'],
    },
  },
  {
    path: '/polls/:pollId/results',
    name: 'poll-results',
    component: () => import('@/views/polls/PollDetailView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['USER', 'BOARD', 'CHAIRMAN', 'ACCOUNTANT'],
    },
  },
  {
    path: '/issues',
    name: 'issues',
    component: () => import('@/views/issues/IssuesView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['USER', 'BOARD', 'CHAIRMAN', 'ACCOUNTANT'],
      requiresApartmentOrBoard: true,
      navKey: 'issues',
      navGroup: 'services',
      icon: 'report_problem',
    },
  },
  {
    path: '/issues/:issueId',
    name: 'issue-detail',
    component: () => import('@/views/issues/IssueDetailView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['USER', 'BOARD', 'CHAIRMAN', 'ACCOUNTANT'],
      requiresApartmentOrBoard: true,
    },
  },
  {
    path: '/documents',
    name: 'documents',
    component: DocumentsView,
    meta: {
      layout: 'AppLayout',
      roles: ['USER', 'BOARD', 'CHAIRMAN', 'ACCOUNTANT'],
      navKey: 'documents',
      navGroup: 'services',
      icon: 'folder_open',
    },
  },
  {
    path: '/accounting',
    name: 'accounting',
    component: AccountingView,
    meta: {
      layout: 'AppLayout',
      roles: ['BOARD', 'CHAIRMAN', 'ACCOUNTANT'],
      navKey: 'accounting',
      navGroup: 'management',
      icon: 'account_balance',
    },
  },
  {
    path: '/apartments',
    name: 'apartments',
    component: () => import('@/views/apartments/ApartmentsView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['BOARD', 'CHAIRMAN'],
      navKey: 'apartments',
      navGroup: 'management',
      icon: 'apartment',
    },
  },
  {
    path: '/apartments/:apartmentId',
    name: 'apartment-card',
    component: () => import('@/views/apartments/ApartmentCardView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['BOARD', 'CHAIRMAN'],
    },
  },
  {
    path: '/board-room',
    name: 'board-room',
    component: () => import('@/views/boardRoom/BoardRoomView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['BOARD', 'CHAIRMAN'],
      navKey: 'boardRoom',
      navGroup: 'management',
      icon: 'meeting_room',
    },
  },
  {
    path: '/board-room/:postId',
    name: 'board-room-detail',
    component: () => import('@/views/boardRoom/BoardTopicDetailView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['BOARD', 'CHAIRMAN'],
    },
  },
  {
    path: '/people',
    name: 'people',
    component: () => import('@/views/people/PeopleView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['CHAIRMAN'],
      navKey: 'people',
      navGroup: 'management',
      icon: 'group',
    },
  },
  {
    path: '/maintenance',
    name: 'maintenance',
    component: () => import('@/views/maintenance/MaintenanceView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['BOARD', 'CHAIRMAN'],
      navKey: 'maintenance',
      navGroup: 'management',
      icon: 'event_repeat',
    },
  },
  {
    path: '/maintenance/new',
    name: 'maintenance-new',
    component: () => import('@/views/maintenance/MaintenanceTaskEditorView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['BOARD', 'CHAIRMAN'],
    },
  },
  {
    path: '/maintenance/:taskId/edit',
    name: 'maintenance-edit',
    component: () => import('@/views/maintenance/MaintenanceTaskEditorView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['BOARD', 'CHAIRMAN'],
    },
  },
  {
    path: '/maintenance/log',
    name: 'maintenance-log',
    component: () => import('@/views/maintenance/MaintenanceLogView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['BOARD', 'CHAIRMAN', 'ACCOUNTANT'],
      navRoles: ['ACCOUNTANT'],
      navKey: 'maintenanceLog',
      navGroup: 'management',
      icon: 'history_edu',
    },
  },
  {
    path: '/maintenance/:taskId',
    name: 'maintenance-detail',
    component: () => import('@/views/maintenance/MaintenanceTaskView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['BOARD', 'CHAIRMAN'],
    },
  },
  {
    path: '/settings/association',
    name: 'settings-association',
    component: () => import('@/views/settings/AssociationSettingsView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['BOARD', 'CHAIRMAN'],
      navKey: 'associationSettings',
      navGroup: 'management',
      icon: 'tune',
    },
  },
  {
    path: '/welcome',
    name: 'welcome',
    component: WelcomeView,
    meta: {
      layout: 'PublicLayout',
      public: true,
      roles: ['USER', 'BOARD', 'CHAIRMAN', 'ACCOUNTANT'],
    },
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/entry/LoginView.vue'),
    meta: {
      layout: 'PublicLayout',
      public: true,
    },
  },
  {
    path: '/login/link',
    name: 'login-link',
    component: () => import('@/views/entry/LinkView.vue'),
    meta: {
      layout: 'PublicLayout',
      public: true,
    },
  },
  {
    path: '/unsubscribe',
    name: 'unsubscribe',
    component: () => import('@/views/entry/UnsubscribeView.vue'),
    meta: {
      layout: 'PublicLayout',
      public: true,
    },
  },
  {
    path: '/notifications',
    name: 'notifications',
    component: () => import('@/views/notifications/NotificationsView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['USER', 'BOARD', 'CHAIRMAN', 'ACCOUNTANT'],
    },
  },
  {
    path: '/settings/profile',
    name: 'settings-profile',
    component: () => import('@/views/settings/ProfileView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['USER', 'BOARD', 'CHAIRMAN', 'ACCOUNTANT'],
    },
  },
  {
    path: '/profile',
    redirect: { name: 'settings-profile' },
  },
  {
    path: '/settings/notifications',
    name: 'settings-notifications',
    component: () => import('@/views/settings/NotificationSettingsView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['USER', 'BOARD', 'CHAIRMAN', 'ACCOUNTANT'],
    },
  },
  {
    path: '/settings/security',
    name: 'settings-security',
    component: () => import('@/views/settings/SecurityView.vue'),
    meta: {
      layout: 'AppLayout',
      roles: ['USER', 'BOARD', 'CHAIRMAN', 'ACCOUNTANT'],
    },
  },
  {
    path: '/theme-lab',
    name: 'theme-lab',
    component: ThemeLabView,
    meta: {
      layout: 'AppLayout',
      roles: ['USER', 'BOARD', 'CHAIRMAN', 'ACCOUNTANT'],
    },
  },
]
