/**
 * Shared communication domain seed fixtures & post/comment helpers (#041).
 * Used by both `src/server/apiMiddleware.ts` and `src/api/offlineDemoData.js`.
 */

import type {
  AuthorBadgeDTO,
  PostCategory,
  PostOrigin,
  PostType,
  TargetScope,
} from '../../api/schema'

export interface MockStoredComment {
  id: string
  post_id: string
  body: string
  author_user_id: string
  author_apartment_id: string | null
  author_badge: AuthorBadgeDTO
  created_at: string
  edited_at: string | null
  hidden_at: string | null
  hidden_reason: string | null
  hidden_by_user_id?: string | null
}

export interface MockStoredPost {
  id: string
  post_type: PostType
  origin?: PostOrigin | null
  category: PostCategory
  title: string
  body: string
  author_user_id: string
  author_apartment_id: string | null
  author_badge: AuthorBadgeDTO
  target_scope: TargetScope
  target_entrance: number | null
  target_apartment_ids: string[] | null
  is_active: boolean
  comments_enabled: boolean
  created_at: string
  edited_at: string | null
  hidden_at: string | null
  hidden_reason: string | null
  hidden_by_user_id?: string | null
  acknowledged_at?: string | null
  acknowledged_by: Record<string, string>
  comments: MockStoredComment[]
}

/**
 * Creates canonical seed posts for forum, official notices, emergencies, apartment threads, and board room.
 * Includes both `author_apartment_id` (used by dynamic badge resolution) and `author_badge` (used by offline projections).
 */
export function createDefaultMockPosts(nowMs: number = Date.now()): MockStoredPost[] {
  const twoHoursAgoIso = new Date(nowMs - 2 * 60 * 60 * 1000).toISOString()
  const ninetyMinAgoIso = new Date(nowMs - 90 * 60 * 1000).toISOString()
  const fortyFiveMinAgoIso = new Date(nowMs - 45 * 60 * 1000).toISOString()

  return [
    {
      id: '018f0000-0000-7000-8000-000000000606',
      post_type: 'FORUM_TOPIC',
      category: 'GENERAL',
      title: 'Weekend courtyard bench repainting helpers',
      body: 'We have two cans of weatherproof timber oil left in the shed. Anyone free on Sunday at 11:00 to help coat the courtyard benches before the rain?',
      author_user_id: '018f0000-0000-7000-8000-000000000102',
      author_apartment_id: '018f0000-0000-7000-8000-000000000314',
      author_badge: {
        display_label: 'Kati Kask (Apt 14)',
        role_badge: 'OWNER',
      },
      target_scope: 'ALL_BUILDING',
      target_entrance: null,
      target_apartment_ids: null,
      is_active: true,
      comments_enabled: true,
      created_at: twoHoursAgoIso,
      edited_at: null,
      hidden_at: null,
      hidden_reason: null,
      acknowledged_by: {},
      comments: [
        {
          id: '018f0000-0000-7000-8000-000000000655',
          post_id: '018f0000-0000-7000-8000-000000000606',
          body: 'I can bring sandpaper and extra brushes from the utility room.',
          author_user_id: '018f0000-0000-7000-8000-000000000101',
          author_apartment_id: '018f0000-0000-7000-8000-000000000301',
          author_badge: {
            display_label: 'Peeter Tamm (Apt 01)',
            role_badge: 'BOARD',
          },
          created_at: ninetyMinAgoIso,
          edited_at: null,
          hidden_at: null,
          hidden_reason: null,
        },
        {
          id: '018f0000-0000-7000-8000-000000000656',
          post_id: '018f0000-0000-7000-8000-000000000606',
          body: 'Thank you Peeter! I will also pick up masking tape tomorrow morning.',
          author_user_id: '018f0000-0000-7000-8000-000000000102',
          author_apartment_id: '018f0000-0000-7000-8000-000000000314',
          author_badge: {
            display_label: 'Kati Kask (Apt 14)',
            role_badge: 'OWNER',
          },
          created_at: fortyFiveMinAgoIso,
          edited_at: null,
          hidden_at: null,
          hidden_reason: null,
        },
      ],
    },
    {
      id: '018f0000-0000-7000-8000-000000000701',
      post_type: 'EMERGENCY',
      category: 'WATER_SHUTOFF',
      title: 'Basement Heating Valve Pressure Drop (Stairwell B)',
      body: 'Pressure sensor in Stairwell B heat exchanger dropped from 2.4 bar to 1.6 bar. Technician is on site inspecting the expansion vessel.',
      author_user_id: '018f0000-0000-7000-8000-000000000101',
      author_apartment_id: '018f0000-0000-7000-8000-000000000301',
      author_badge: {
        display_label: 'Peeter Tamm (Apt 01)',
        role_badge: 'BOARD',
      },
      target_scope: 'ALL_BUILDING',
      target_entrance: null,
      target_apartment_ids: null,
      is_active: true,
      comments_enabled: true,
      created_at: '2026-10-25T08:15:00Z',
      edited_at: null,
      hidden_at: null,
      hidden_reason: null,
      acknowledged_at: null,
      acknowledged_by: {},
      comments: [],
    },
    {
      id: '018f0000-0000-7000-8000-000000000601',
      post_type: 'OFFICIAL_NOTICE',
      category: 'GENERAL',
      title: 'October 2026 Utility Meter Submission & Courtyard Maintenance',
      body: 'Dear residents of Sõpruse pst 12,\n\nPlease submit all October 2026 cold and hot water readings by November 4 at 23:59. Unsubmitted meters will be automatically estimated from your 3-month rolling average.\n\nAdditionally, autumn courtyard leaf clearing and underground garage drain flushing will take place on Saturday, November 7 from 09:00 to 14:00.',
      author_user_id: '018f0000-0000-7000-8000-000000000101',
      author_apartment_id: '018f0000-0000-7000-8000-000000000301',
      author_badge: {
        display_label: 'Peeter Tamm (Apt 01)',
        role_badge: 'BOARD',
      },
      target_scope: 'ALL_BUILDING',
      target_entrance: null,
      target_apartment_ids: null,
      is_active: true,
      comments_enabled: true,
      created_at: '2026-10-23T11:00:00Z',
      edited_at: null,
      hidden_at: null,
      hidden_reason: null,
      acknowledged_by: {},
      comments: [
        {
          id: '018f0000-0000-7000-8000-000000000651',
          post_id: '018f0000-0000-7000-8000-000000000601',
          body: 'Thank you Peeter! Should cars be moved out of the courtyard parking spots before 08:45 on Saturday?',
          author_user_id: '018f0000-0000-7000-8000-000000000102',
          author_apartment_id: '018f0000-0000-7000-8000-000000000314',
          author_badge: {
            display_label: 'Kati Kask (Apt 14)',
            role_badge: 'OWNER',
          },
          created_at: '2026-10-23T13:20:00Z',
          edited_at: null,
          hidden_at: null,
          hidden_reason: null,
        },
        {
          id: '018f0000-0000-7000-8000-000000000652',
          post_id: '018f0000-0000-7000-8000-000000000601',
          body: 'Yes, please clear the courtyard bays by 08:45 so the maintenance vehicle can access all corners.',
          author_user_id: '018f0000-0000-7000-8000-000000000101',
          author_apartment_id: '018f0000-0000-7000-8000-000000000301',
          author_badge: {
            display_label: 'Peeter Tamm (Apt 01)',
            role_badge: 'BOARD',
          },
          created_at: '2026-10-23T14:05:00Z',
          edited_at: null,
          hidden_at: null,
          hidden_reason: null,
        },
      ],
    },
    {
      id: '018f0000-0000-7000-8000-000000000605',
      post_type: 'FORUM_TOPIC',
      category: 'MARKETPLACE',
      title: 'Commercial courier discount code spam',
      body: 'Use my referral link every day for commercial deliveries and promotional flyers in every mailbox.',
      author_user_id: '018f0000-0000-7000-8000-000000000104',
      author_apartment_id: '018f0000-0000-7000-8000-000000000302',
      author_badge: {
        display_label: 'M. S. (Apt 02)',
        role_badge: 'RESIDENT',
      },
      target_scope: 'ALL_BUILDING',
      target_entrance: null,
      target_apartment_ids: null,
      is_active: true,
      comments_enabled: true,
      created_at: '2026-10-22T15:00:00Z',
      edited_at: null,
      hidden_at: '2026-10-22T16:15:00Z',
      hidden_reason: 'Commercial advertising is not allowed in the building forum.',
      acknowledged_by: {},
      comments: [],
    },
    {
      id: '018f0000-0000-7000-8000-000000000602',
      post_type: 'FORUM_TOPIC',
      category: 'MAINTENANCE',
      title: 'Bicycle Storage Rack Expansion in Ground Floor Room #2',
      body: 'Several families on the 3rd and 4th floors proposed installing vertical wall-mounted bike hooks in the secondary storage room. Total quote for 12 heavy-duty hooks is 480 EUR from the maintenance fund.',
      author_user_id: '018f0000-0000-7000-8000-000000000102',
      author_apartment_id: '018f0000-0000-7000-8000-000000000314',
      author_badge: {
        display_label: 'Kati Kask (Apt 14)',
        role_badge: 'OWNER',
      },
      target_scope: 'ALL_BUILDING',
      target_entrance: null,
      target_apartment_ids: null,
      is_active: true,
      comments_enabled: true,
      created_at: '2026-10-20T17:30:00Z',
      edited_at: '2026-10-20T18:05:00Z',
      hidden_at: null,
      hidden_reason: null,
      acknowledged_by: {},
      comments: [
        {
          id: '018f0000-0000-7000-8000-000000000653',
          post_id: '018f0000-0000-7000-8000-000000000602',
          body: 'We have sufficient allocation in the Q4 minor improvements budget line to cover 480 EUR without affecting the reserve fund.',
          author_user_id: '018f0000-0000-7000-8000-000000000103',
          author_apartment_id: null,
          author_badge: {
            display_label: 'Marika Rebane',
            role_badge: 'ACCOUNTANT',
          },
          created_at: '2026-10-21T09:15:00Z',
          edited_at: '2026-10-21T09:22:00Z',
          hidden_at: null,
          hidden_reason: null,
        },
        {
          id: '018f0000-0000-7000-8000-000000000654',
          post_id: '018f0000-0000-7000-8000-000000000602',
          body: 'Why are ground floor residents paying for upper floor bikes?! Keep them in your own flats!',
          author_user_id: '018f0000-0000-7000-8000-000000000104',
          author_apartment_id: '018f0000-0000-7000-8000-000000000302',
          author_badge: {
            display_label: 'M. S. (Apt 02)',
            role_badge: 'RESIDENT',
          },
          created_at: '2026-10-21T11:40:00Z',
          edited_at: null,
          hidden_at: '2026-10-21T12:10:00Z',
          hidden_reason: 'Personal attacks against neighbors violate house rules.',
        },
      ],
    },
    {
      id: '018f0000-0000-7000-8000-000000000603',
      post_type: 'OFFICIAL_NOTICE',
      category: 'MAINTENANCE',
      title: 'District Heating Substation Winter Calibration Completed',
      body: 'Utilitas Tallinn completed the scheduled diagnostic check of our primary heating substation. Efficiency is within 99.1% of nominal specification and night-time setback curve has been calibrated.',
      author_user_id: '018f0000-0000-7000-8000-000000000101',
      author_apartment_id: '018f0000-0000-7000-8000-000000000301',
      author_badge: {
        display_label: 'Peeter Tamm (Apt 01)',
        role_badge: 'BOARD',
      },
      target_scope: 'ALL_BUILDING',
      target_entrance: null,
      target_apartment_ids: null,
      is_active: true,
      comments_enabled: true,
      created_at: '2026-10-15T10:00:00Z',
      edited_at: null,
      hidden_at: null,
      hidden_reason: null,
      acknowledged_by: {},
      comments: [],
    },
    {
      id: '018f0000-0000-7000-8000-000000000751',
      post_type: 'APARTMENT_THREAD',
      category: 'MAINTENANCE',
      title: 'Access to the cold water meter in apartment 14',
      body: 'Hello! Could we arrange a 10-minute inspection of the bathroom cold water meter seal this Thursday between 17:00 and 19:00?',
      author_user_id: '018f0000-0000-7000-8000-000000000101',
      author_apartment_id: null,
      author_badge: {
        display_label: 'Chairman',
        role_badge: 'BOARD',
      },
      target_scope: 'APARTMENT_LIST',
      target_entrance: null,
      target_apartment_ids: ['018f0000-0000-7000-8000-000000000314'],
      is_active: true,
      comments_enabled: true,
      created_at: '2026-10-24T10:15:00Z',
      edited_at: null,
      hidden_at: null,
      hidden_reason: null,
      acknowledged_by: {},
      comments: [
        {
          id: '018f0000-0000-7000-8000-000000000752',
          post_id: '018f0000-0000-7000-8000-000000000751',
          body: 'Thursday at 18:00 works well for us. See you then!',
          author_user_id: '018f0000-0000-7000-8000-000000000102',
          author_apartment_id: null,
          author_badge: {
            display_label: 'Kati Kask (Apt 14)',
            role_badge: 'OWNER',
          },
          created_at: '2026-10-24T12:40:00Z',
          edited_at: null,
          hidden_at: null,
          hidden_reason: null,
        },
      ],
    },
    {
      id: '018f0000-0000-7000-8000-000000000761',
      post_type: 'BOARD_TOPIC',
      category: 'GENERAL',
      title: 'Where the keys to the basement and the roof are',
      body: 'The spare set of keys to the basement technical room, district heating node, and roof hatch is stored in the locked fire-rated cabinet in Entrance 1 utility room. The combination was shared at the October board meeting.',
      author_user_id: '018f0000-0000-7000-8000-000000000101',
      author_apartment_id: null,
      author_badge: {
        display_label: 'Oleg Sidorov',
        role_badge: 'BOARD',
      },
      target_scope: 'ALL_BUILDING',
      target_entrance: null,
      target_apartment_ids: null,
      is_active: true,
      comments_enabled: true,
      created_at: '2026-10-25T11:30:00Z',
      edited_at: null,
      hidden_at: null,
      hidden_reason: null,
      acknowledged_by: {},
      comments: [
        {
          id: '018f0000-0000-7000-8000-000000000762',
          post_id: '018f0000-0000-7000-8000-000000000761',
          body: 'Confirmed — I also labelled the roof hatch key and the main water shut-off valve key on the yellow tag.',
          author_user_id: '018f0000-0000-7000-8000-000000000105',
          author_apartment_id: null,
          author_badge: {
            display_label: 'Peeter Saar',
            role_badge: 'BOARD',
          },
          created_at: '2026-10-25T14:20:00Z',
          edited_at: null,
          hidden_at: null,
          hidden_reason: null,
        },
      ],
    },
    {
      id: '018f0000-0000-7000-8000-000000000604',
      post_type: 'OFFICIAL_NOTICE',
      origin: 'MAINTENANCE',
      category: 'MAINTENANCE',
      title: 'Annual Fire Extinguisher Inspection',
      body: 'Inspector will check all stairwell and common area fire safety equipment. No access to individual flats needed.\n\nPlanned date: 2026-11-05',
      author_user_id: '018f0000-0000-7000-8000-000000000101',
      author_apartment_id: '018f0000-0000-7000-8000-000000000301',
      author_badge: {
        display_label: 'Peeter Tamm (Apt 01)',
        role_badge: 'BOARD',
      },
      target_scope: 'ALL_BUILDING',
      target_entrance: null,
      target_apartment_ids: null,
      is_active: true,
      comments_enabled: false,
      created_at: '2026-10-25T09:00:00Z',
      edited_at: null,
      hidden_at: null,
      hidden_reason: null,
      acknowledged_by: {},
      comments: [],
    },
    {
      id: '018f0000-0000-7000-8000-000000000763',
      post_type: 'BOARD_TOPIC',
      origin: 'MAINTENANCE',
      category: 'MAINTENANCE',
      title: 'Maintenance: Inspect fire extinguishers, overdue since 05.11.2026',
      body: 'Basement, technical rooms, and all 4 landings in both entrances. Certified technician needed.',
      author_user_id: '018f0000-0000-7000-8000-000000000101',
      author_apartment_id: null,
      author_badge: {
        display_label: 'Oleg Sidorov',
        role_badge: 'BOARD',
      },
      target_scope: 'ALL_BUILDING',
      target_entrance: null,
      target_apartment_ids: null,
      is_active: true,
      comments_enabled: true,
      created_at: '2026-10-25T09:00:00Z',
      edited_at: null,
      hidden_at: null,
      hidden_reason: null,
      acknowledged_by: {},
      comments: [
        {
          id: '018f0000-0000-7000-8000-000000000764',
          post_id: '018f0000-0000-7000-8000-000000000763',
          body: 'Still not done: overdue since 05.11.2026 (reminder 1)',
          author_user_id: '018f0000-0000-7000-8000-000000000101',
          author_apartment_id: null,
          author_badge: {
            display_label: 'Oleg Sidorov',
            role_badge: 'BOARD',
          },
          created_at: '2026-11-06T09:00:00Z',
          edited_at: null,
          hidden_at: null,
          hidden_reason: null,
        },
      ],
    },
  ]
}
