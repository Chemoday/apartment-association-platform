import type { SeedUser } from '../state.js';
import type { EmergencyView, PostCategory, PostType, TargetScope } from '../../api/schema.js';
import { type RouteContext, sendJson, sendError, readBody } from '../http.js';
import {
  DEMO_USERS,
  DEMO_APARTMENT_CARDS,
  membershipsByUser,
  postsStore,
  getUserNotifications,
  dispatchServerMaintenanceAndNoticeNotifications,
  emitApartmentThreadNotifications,
  resolveAuthorBadge,
  type InternalPost,
  type InternalComment,
} from '../state.js';
import {
  COMMENT_BODY_MAX_LENGTH,
  POST_BODY_MAX_LENGTH,
  POST_TITLE_MAX_LENGTH,
  canViewerSeePost,
  getEditWindowDeadlineMs,
  hasDisallowedControlChars,
  isCommentHideableOnPost,
  isPostHideable,
  isWithinEditWindow,
  projectCommentForViewer,
  validateCommentEdit,
  validateHideReason,
} from '../../utils/communication.js';

export async function handleCommunicationRoutes(ctx: RouteContext<SeedUser>): Promise<boolean> {
  const { req, res, urlObj, pathname, method, user, isBoard } = ctx;

    if (pathname === '/api/v1/communication/emergencies/active' && method === 'GET') {
      const userMems = membershipsByUser[user.user_id] || [];
      const activeList: EmergencyView[] = postsStore
        .filter(
          (p) =>
            p.post_type === 'EMERGENCY' &&
            p.is_active &&
            canViewerSeePost(p, {
              viewerUserId: user.user_id,
              viewerRole: user.building_role,
              memberships: userMems,
            })
        )
        .map((p) => ({
          id: p.id,
          post_type: p.post_type,
          category: p.category,
          title: p.title,
          body: p.body,
          author_badge: resolveAuthorBadge(p.author_user_id),
          is_mine: p.author_user_id === user.user_id,
          target_scope: p.target_scope,
          target_entrance: p.target_entrance,
          target_apartment_ids: p.target_apartment_ids,
          is_active: p.is_active,
          comments_enabled: p.comments_enabled,
          comments_count: p.comments.length,
          created_at: p.created_at,
          last_activity_at:
            p.comments.length > 0 ? p.comments[p.comments.length - 1].created_at : p.created_at,
          acknowledged_at: p.acknowledged_by[user.user_id] || null,
          origin: p.origin || null,
          edited_at: p.edited_at || null,
          hidden_at: p.hidden_at || null,
          hidden_reason: p.hidden_at ? p.hidden_reason || null : null,
        }));
      return sendJson(res, 200, activeList);
    }

    // 12. POST /api/v1/communication/emergencies/{id}/acknowledge
    const ackMatch = pathname.match(/^\/api\/v1\/communication\/emergencies\/([^/]+)\/acknowledge$/);
    if (ackMatch && method === 'POST') {
      const post = postsStore.find((p) => p.id === ackMatch[1]);
      if (!post) return sendError(res, 404, 'POST_NOT_FOUND', 'Emergency alert not found.');
      const nowIso = new Date().toISOString();
      post.acknowledged_by[user.user_id] = nowIso;
      return sendJson(res, 200, {
        post_id: post.id,
        acknowledged_at: nowIso,
      });
    }

    // 13. POST /api/v1/communication/emergencies/{id}/resolve
    const resolveMatch = pathname.match(/^\/api\/v1\/communication\/emergencies\/([^/]+)\/resolve$/);
    if (resolveMatch && method === 'POST') {
      if (!isBoard) {
        return sendError(res, 403, 'FORBIDDEN', 'Only Board members can resolve emergencies.');
      }
      const post = postsStore.find((p) => p.id === resolveMatch[1]);
      if (!post) return sendError(res, 404, 'POST_NOT_FOUND', 'Emergency alert not found.');
      post.is_active = false;
      // Add EMERGENCY_RESOLVED notification for all other demo users
      for (const demoUser of DEMO_USERS) {
        if (demoUser.user_id !== user.user_id) {
          const list = getUserNotifications(demoUser.user_id);
          list.unshift({
            id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
            user_id: demoUser.user_id,
            event_type: 'EMERGENCY_RESOLVED',
            subject_type: 'post',
            subject_id: post.id,
            params: {
              category: post.category,
              target_scope: post.target_scope,
              target_entrance: post.target_entrance,
            },
            created_at: new Date().toISOString(),
            read_at: null,
          });
        }
      }
      return sendJson(res, 200, {
        post_id: post.id,
        is_active: false,
      });
    }

    // 14. GET & POST /api/v1/communication/posts
    if (pathname === '/api/v1/communication/posts' && method === 'GET') {
      const postType = urlObj.searchParams.get('post_type') as PostType | null;
      const apartmentId = urlObj.searchParams.get('apartment_id');
      const category = urlObj.searchParams.get('category');
      const limit = Number(urlObj.searchParams.get('limit') || '20');
      const offset = Number(urlObj.searchParams.get('offset') || '0');
      const userMems = membershipsByUser[user.user_id] || [];
      const visibilityCtx = {
        viewerUserId: user.user_id,
        viewerRole: user.building_role,
        memberships: userMems,
      };

      if (apartmentId && postType !== 'APARTMENT_THREAD') {
        return sendError(
          res,
          422,
          'VALIDATION_ERROR',
          'apartment_id filter is only valid with post_type=APARTMENT_THREAD.'
        );
      }

      let filtered = postsStore.filter(
        (p) =>
          p.post_type !== 'EMERGENCY' &&
          p.post_type !== 'APARTMENT_THREAD' &&
          p.post_type !== 'BOARD_TOPIC' &&
          canViewerSeePost(p, visibilityCtx)
      );

      if (postType === 'APARTMENT_THREAD') {
        filtered = postsStore.filter((p) => {
          if (p.post_type !== 'APARTMENT_THREAD') return false;
          if (apartmentId && !p.target_apartment_ids?.includes(apartmentId)) return false;
          return canViewerSeePost(p, visibilityCtx);
        });
        filtered.sort((a, b) => {
          const aLast =
            a.comments.length > 0 ? a.comments[a.comments.length - 1].created_at : a.created_at;
          const bLast =
            b.comments.length > 0 ? b.comments[b.comments.length - 1].created_at : b.created_at;
          return new Date(bLast).getTime() - new Date(aLast).getTime() || b.id.localeCompare(a.id);
        });
      } else if (postType === 'BOARD_TOPIC') {
        if (!isBoard) {
          return sendError(res, 404, 'POST_NOT_FOUND', 'Post not found.');
        }
        filtered = postsStore.filter(
          (p) => p.post_type === 'BOARD_TOPIC' && canViewerSeePost(p, visibilityCtx)
        );
        filtered.sort((a, b) => {
          const aLast =
            a.comments.length > 0 ? a.comments[a.comments.length - 1].created_at : a.created_at;
          const bLast =
            b.comments.length > 0 ? b.comments[b.comments.length - 1].created_at : b.created_at;
          return new Date(bLast).getTime() - new Date(aLast).getTime() || b.id.localeCompare(a.id);
        });
      } else if (postType) {
        filtered = postsStore.filter(
          (p) => p.post_type === postType && canViewerSeePost(p, visibilityCtx)
        );
        filtered.sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime() ||
            b.id.localeCompare(a.id)
        );
      } else {
        filtered.sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime() ||
            b.id.localeCompare(a.id)
        );
      }

      if (category) {
        filtered = filtered.filter((p) => p.category === category);
      }

      const paged = filtered.slice(offset, offset + limit).map((p) => ({
        id: p.id,
        post_type: p.post_type,
        category: p.category,
        title: p.title,
        body: p.body,
        author_badge: resolveAuthorBadge(
          p.author_user_id,
          p.post_type,
          p.target_apartment_ids?.[0] || null
        ),
        is_mine: p.author_user_id === user.user_id,
        target_scope: p.target_scope,
        target_entrance: p.target_entrance,
        target_apartment_ids: p.target_apartment_ids,
        is_active: p.is_active,
        comments_enabled: p.comments_enabled,
        comments_count: p.comments.length,
        created_at: p.created_at,
        last_activity_at:
          p.comments.length > 0 ? p.comments[p.comments.length - 1].created_at : p.created_at,
        origin: p.origin || null,
        edited_at: p.edited_at || null,
        hidden_at: p.hidden_at || null,
        hidden_reason: p.hidden_at ? p.hidden_reason || null : null,
      }));
      return sendJson(res, 200, paged);
    }

    if (pathname === '/api/v1/communication/posts' && method === 'POST') {
      const body = await readBody(req);
      const postType: PostType =
        typeof body.post_type === 'string' && body.post_type
          ? (body.post_type as PostType)
          : 'FORUM_TOPIC';
      const hasControlChars = (str: string) => {
        for (let i = 0; i < str.length; i += 1) {
          const code = str.charCodeAt(i);
          if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
            return true;
          }
        }
        return false;
      };
      const cleanTitle = typeof body.title === 'string' ? body.title.trim() : '';
      const cleanBody = typeof body.body === 'string' ? body.body.trim() : '';
      if (!cleanTitle || !cleanBody || hasControlChars(cleanTitle) || hasControlChars(cleanBody)) {
        return sendError(
          res,
          422,
          'VALIDATION_ERROR',
          'Title and body must be non-empty plain text.'
        );
      }

      if ((postType === 'OFFICIAL_NOTICE' || postType === 'EMERGENCY') && !isBoard) {
        return sendError(
          res,
          403,
          'FORBIDDEN',
          'Only Board members can publish notices or emergencies.'
        );
      }

      if (postType === 'APARTMENT_THREAD') {
        if (body.author_apartment_id !== undefined && body.author_apartment_id !== null) {
          return sendError(
            res,
            422,
            'INVALID_AUTHOR_APARTMENT',
            'author_apartment_id is not allowed on APARTMENT_THREAD.'
          );
        }
        if (body.comments_enabled === false) {
          return sendError(
            res,
            422,
            'VALIDATION_ERROR',
            'comments_enabled must be true for APARTMENT_THREAD.'
          );
        }
        if (
          body.target_scope !== 'APARTMENT_LIST' ||
          !Array.isArray(body.target_apartment_ids) ||
          body.target_apartment_ids.length !== 1
        ) {
          return sendError(
            res,
            422,
            'INVALID_TARGET',
            'APARTMENT_THREAD requires target_scope=APARTMENT_LIST with exactly 1 apartment.'
          );
        }
        const targetAptId = body.target_apartment_ids[0];
        const aptCard = DEMO_APARTMENT_CARDS.find((a) => a.apartment_id === targetAptId);
        if (!aptCard) {
          return sendError(res, 422, 'INVALID_TARGET', 'Target apartment not found.');
        }
        if (!isBoard) {
          const userMems = membershipsByUser[user.user_id] || [];
          if (!userMems.some((m) => m.apartment_id === targetAptId)) {
            return sendError(
              res,
              403,
              'FORBIDDEN',
              'You do not have access to this apartment.'
            );
          }
        }
        if (aptCard.residents.length === 0) {
          return sendError(
            res,
            422,
            'APARTMENT_HAS_NO_RESIDENTS',
            'This apartment has no registered residents yet.'
          );
        }
      }

      if (postType === 'BOARD_TOPIC') {
        if (!isBoard) {
          return sendError(res, 403, 'FORBIDDEN', 'Only Board members can publish board topics.');
        }
        if (body.author_apartment_id !== undefined && body.author_apartment_id !== null) {
          return sendError(
            res,
            422,
            'INVALID_AUTHOR_APARTMENT',
            'author_apartment_id is not allowed on BOARD_TOPIC.'
          );
        }
        if (
          (body.target_scope && body.target_scope !== 'ALL_BUILDING') ||
          body.target_entrance ||
          body.target_apartment_ids
        ) {
          return sendError(
            res,
            422,
            'INVALID_TARGET',
            'BOARD_TOPIC does not accept target fields.'
          );
        }
      }

      const targetApartmentIds = Array.isArray(body.target_apartment_ids)
        ? body.target_apartment_ids.map(String)
        : null;
      const authorApartmentId =
        typeof body.author_apartment_id === 'string' && body.author_apartment_id
          ? body.author_apartment_id
          : null;
      const created: InternalPost = {
        id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
        post_type: postType,
        category:
          typeof body.category === 'string' && body.category
            ? (body.category as PostCategory)
            : 'GENERAL',
        title: cleanTitle,
        body: cleanBody,
        author_user_id: user.user_id,
        author_apartment_id:
          postType === 'BOARD_TOPIC'
            ? null
            : postType === 'APARTMENT_THREAD'
              ? isBoard
                ? null
                : targetApartmentIds?.[0] || null
              : authorApartmentId,
        target_scope:
          typeof body.target_scope === 'string' && body.target_scope
            ? (body.target_scope as TargetScope)
            : 'ALL_BUILDING',
        target_entrance:
          typeof body.target_entrance === 'number' ? body.target_entrance : null,
        target_apartment_ids: targetApartmentIds,
        is_active: true,
        comments_enabled: body.comments_enabled !== false,
        created_at: new Date().toISOString(),
        edited_at: null,
        hidden_at: null,
        hidden_reason: null,
        origin: null,
        acknowledged_by: {},
        comments: [],
      };
      postsStore.unshift(created);

      if (postType === 'OFFICIAL_NOTICE') {
        dispatchServerMaintenanceAndNoticeNotifications({
          event_type: 'NOTICE_PUBLISHED',
          subject_type: 'post',
          subject_id: created.id,
          target_scope: created.target_scope,
          target_entrance: created.target_entrance,
          target_apartment_ids: created.target_apartment_ids,
          author_user_id: user.user_id,
          created_at: created.created_at,
        });
      }

      // If an emergency is published, notify all other demo users (author never gets own alert)
      if (postType === 'EMERGENCY') {
        for (const demoUser of DEMO_USERS) {
          if (demoUser.user_id !== user.user_id) {
            const list = getUserNotifications(demoUser.user_id);
            list.unshift({
              id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
              user_id: demoUser.user_id,
              event_type: 'EMERGENCY_PUBLISHED',
              subject_type: 'post',
              subject_id: created.id,
              params: {
                category: created.category,
                target_scope: created.target_scope,
                target_entrance: created.target_entrance,
              },
              created_at: created.created_at,
              read_at: null,
            });
          }
        }
      }

      if (postType === 'APARTMENT_THREAD' && created.target_apartment_ids?.[0]) {
        emitApartmentThreadNotifications(
          created.id,
          created.target_apartment_ids[0],
          user,
          created.created_at
        );
      }

      return sendJson(res, 201, {
        id: created.id,
        post_type: created.post_type,
        category: created.category,
        title: created.title,
        body: created.body,
        author_badge: resolveAuthorBadge(
          created.author_user_id,
          created.post_type,
          created.target_apartment_ids?.[0] || null
        ),
        is_mine: true,
        target_scope: created.target_scope,
        target_entrance: created.target_entrance,
        target_apartment_ids: created.target_apartment_ids,
        is_active: created.is_active,
        comments_enabled: created.comments_enabled,
        comments_count: 0,
        created_at: created.created_at,
        last_activity_at: created.created_at,
        origin: null,
        edited_at: null,
        hidden_at: null,
        hidden_reason: null,
      });
    }

    // 15. GET & DELETE /api/v1/communication/posts/{post_id}
    const postDetailMatch = pathname.match(/^\/api\/v1\/communication\/posts\/([^/]+)$/);
    if (postDetailMatch && method === 'GET') {
      const post = postsStore.find((p) => p.id === postDetailMatch[1]);
      const userMems = membershipsByUser[user.user_id] || [];
      if (
        !post ||
        !canViewerSeePost(post, {
          viewerUserId: user.user_id,
          viewerRole: user.building_role,
          memberships: userMems,
        })
      ) {
        return sendError(res, 404, 'POST_NOT_FOUND', 'Post not found.');
      }

      const rawLimit = Number(urlObj.searchParams.get('comments_limit') || '200');
      const commentsLimit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500)
        : 200;
      const rawOffset = Number(urlObj.searchParams.get('comments_offset') || '0');
      const commentsOffset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;
      const pagedComments = post.comments.slice(commentsOffset, commentsOffset + commentsLimit);

      const targetAptId = post.target_apartment_ids?.[0] || null;
      return sendJson(res, 200, {
        id: post.id,
        post_type: post.post_type,
        category: post.category,
        title: post.title,
        body: post.body,
        author_badge: resolveAuthorBadge(post.author_user_id, post.post_type, targetAptId),
        is_mine: post.author_user_id === user.user_id,
        target_scope: post.target_scope,
        target_entrance: post.target_entrance,
        target_apartment_ids: post.target_apartment_ids,
        is_active: post.is_active,
        comments_enabled: post.comments_enabled,
        comments_count: post.comments.length,
        created_at: post.created_at,
        last_activity_at:
          post.comments.length > 0
            ? post.comments[post.comments.length - 1].created_at
            : post.created_at,
        origin: post.origin || null,
        edited_at: post.edited_at || null,
        hidden_at: post.hidden_at || null,
        hidden_reason: post.hidden_at ? post.hidden_reason || null : null,
        comments: pagedComments.map((c) =>
          projectCommentForViewer(c, {
            postId: post.id,
            viewerUserId: user.user_id,
            viewerRole: user.building_role,
            authorBadge: resolveAuthorBadge(c.author_user_id, post.post_type, targetAptId),
          })
        ),
      });
    }

    if (postDetailMatch && method === 'DELETE') {
      const idx = postsStore.findIndex((p) => p.id === postDetailMatch[1]);
      if (idx === -1) return sendError(res, 404, 'POST_NOT_FOUND', 'Post not found.');
      const targetPost = postsStore[idx];
      if (!isBoard) {
        return sendError(res, 403, 'FORBIDDEN', 'Only Board members can delete topics.');
      }
      if (targetPost.post_type !== 'FORUM_TOPIC' && targetPost.post_type !== 'BOARD_TOPIC') {
        return sendError(res, 409, 'POST_NOT_DELETABLE', 'This post cannot be deleted.', {
          post_type: targetPost.post_type,
        });
      }
      postsStore.splice(idx, 1);
      res.statusCode = 204;
      { res.end(); return true; }
    }

    // 16. POST /api/v1/communication/posts/{post_id}/comments
    const commentMatch = pathname.match(/^\/api\/v1\/communication\/posts\/([^/]+)\/comments$/);
    if (commentMatch && method === 'POST') {
      const post = postsStore.find((p) => p.id === commentMatch[1]);
      const userMems = membershipsByUser[user.user_id] || [];
      if (
        !post ||
        !canViewerSeePost(post, {
          viewerUserId: user.user_id,
          viewerRole: user.building_role,
          memberships: userMems,
        })
      ) {
        return sendError(res, 404, 'POST_NOT_FOUND', 'Post not found.');
      }
      if (post.hidden_at) {
        return sendError(res, 409, 'POST_HIDDEN', 'Cannot comment on a hidden post.');
      }
      if (!post.comments_enabled) {
        return sendError(res, 409, 'COMMENTS_DISABLED', 'Comments are disabled on this post.');
      }
      const body = await readBody(req);
      const hasControlChars = (str: string) => {
        for (let i = 0; i < str.length; i += 1) {
          const code = str.charCodeAt(i);
          if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
            return true;
          }
        }
        return false;
      };
      const cleanCommentBody = typeof body.body === 'string' ? body.body.trim() : '';
      if (!cleanCommentBody || hasControlChars(cleanCommentBody)) {
        return sendError(
          res,
          422,
          'VALIDATION_ERROR',
          'Comment body must be non-empty plain text.'
        );
      }
      if (post.post_type === 'APARTMENT_THREAD' || post.post_type === 'BOARD_TOPIC') {
        if (body.author_apartment_id !== undefined && body.author_apartment_id !== null) {
          return sendError(
            res,
            422,
            'INVALID_AUTHOR_APARTMENT',
            'author_apartment_id is not allowed on this thread.'
          );
        }
      }
      const comment: InternalComment = {
        id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
        post_id: post.id,
        body: cleanCommentBody,
        author_user_id: user.user_id,
        author_apartment_id:
          post.post_type === 'BOARD_TOPIC'
            ? null
            : post.post_type === 'APARTMENT_THREAD'
              ? isBoard
                ? null
                : post.target_apartment_ids?.[0] || null
              : typeof body.author_apartment_id === 'string' && body.author_apartment_id
                ? body.author_apartment_id
                : null,
        created_at: new Date().toISOString(),
        edited_at: null,
        hidden_at: null,
        hidden_reason: null,
      };
      post.comments.push(comment);
      if (post.post_type === 'APARTMENT_THREAD' && post.target_apartment_ids?.[0]) {
        emitApartmentThreadNotifications(
          post.id,
          post.target_apartment_ids[0],
          user,
          comment.created_at
        );
      }
      return sendJson(res, 201, {
        id: comment.id,
        post_id: post.id,
        body: comment.body,
        author_badge: resolveAuthorBadge(
          comment.author_user_id,
          post.post_type,
          post.target_apartment_ids?.[0] || null
        ),
        is_mine: true,
        created_at: comment.created_at,
        edited_at: null,
        hidden_at: null,
        hidden_reason: null,
      });
    }

    // 16b. POST /api/v1/communication/posts/{post_id}/hide & /unhide (#028)
    const safeDecodePathParam = (raw: string): string | null => {
      try {
        return decodeURIComponent(raw);
      } catch {
        return null;
      }
    };
    const postHideMatch = pathname.match(
      /^\/api\/v1\/communication\/posts\/([^/]+)\/(hide|unhide)$/
    );
    if (postHideMatch && method === 'POST') {
      const postId = safeDecodePathParam(postHideMatch[1]);
      const action = postHideMatch[2];
      if (!isBoard) {
        return sendError(res, 403, 'FORBIDDEN', 'Only Board members can moderate forum topics.');
      }
      const post = postId ? postsStore.find((p) => p.id === postId) : null;
      if (!post) {
        return sendError(res, 404, 'POST_NOT_FOUND', 'Post not found.');
      }
      if (!isPostHideable(post)) {
        return sendError(res, 409, 'POST_NOT_HIDEABLE', 'This post cannot be hidden.', {
          post_type: post.post_type,
        });
      }
      if (action === 'hide') {
        const body = await readBody(req);
        const check = validateHideReason(typeof body?.reason === 'string' ? body.reason : null);
        if (!check.valid) {
          return sendError(
            res,
            422,
            'VALIDATION_ERROR',
            'Hide reason must be 1 to 500 plain-text characters.'
          );
        }
        if (!post.hidden_at) {
          post.hidden_at = new Date().toISOString();
          post.hidden_reason = check.reason;
          post.hidden_by_user_id = user.user_id;
        }
      } else {
        post.hidden_at = null;
        post.hidden_reason = null;
        post.hidden_by_user_id = null;
      }
      const targetAptId = post.target_apartment_ids?.[0] || null;
      return sendJson(res, 200, {
        id: post.id,
        post_type: post.post_type,
        category: post.category,
        title: post.title,
        body: post.body,
        author_badge: resolveAuthorBadge(post.author_user_id, post.post_type, targetAptId),
        is_mine: post.author_user_id === user.user_id,
        target_scope: post.target_scope,
        target_entrance: post.target_entrance,
        target_apartment_ids: post.target_apartment_ids,
        is_active: post.is_active,
        comments_enabled: post.comments_enabled,
        comments_count: post.comments.length,
        created_at: post.created_at,
        last_activity_at:
          post.comments.length > 0
            ? post.comments[post.comments.length - 1].created_at
            : post.created_at,
        origin: post.origin || null,
        edited_at: post.edited_at || null,
        hidden_at: post.hidden_at || null,
        hidden_reason: post.hidden_at ? post.hidden_reason || null : null,
      });
    }

    // 16c. POST /api/v1/communication/posts/{post_id}/comments/{comment_id}/hide & /unhide (#028)
    const commentHideMatch = pathname.match(
      /^\/api\/v1\/communication\/posts\/([^/]+)\/comments\/([^/]+)\/(hide|unhide)$/
    );
    if (commentHideMatch && method === 'POST') {
      const postId = safeDecodePathParam(commentHideMatch[1]);
      const commentId = safeDecodePathParam(commentHideMatch[2]);
      const action = commentHideMatch[3];
      if (!isBoard) {
        return sendError(res, 403, 'FORBIDDEN', 'Only Board members can moderate comments.');
      }
      const post = postId ? postsStore.find((p) => p.id === postId) : null;
      if (!post) {
        return sendError(res, 404, 'POST_NOT_FOUND', 'Post not found.');
      }
      if (!isCommentHideableOnPost(post)) {
        return sendError(
          res,
          409,
          'COMMENT_NOT_HIDEABLE',
          'Comments on this post cannot be hidden.',
          { post_type: post.post_type }
        );
      }
      const comment = commentId ? post.comments.find((c) => c.id === commentId) : null;
      if (!comment) {
        return sendError(res, 404, 'COMMENT_NOT_FOUND', 'Comment not found.');
      }
      if (action === 'hide') {
        const body = await readBody(req);
        const check = validateHideReason(typeof body?.reason === 'string' ? body.reason : null);
        if (!check.valid) {
          return sendError(
            res,
            422,
            'VALIDATION_ERROR',
            'Hide reason must be 1 to 500 plain-text characters.'
          );
        }
        if (!comment.hidden_at) {
          comment.hidden_at = new Date().toISOString();
          comment.hidden_reason = check.reason;
          comment.hidden_by_user_id = user.user_id;
        }
      } else {
        comment.hidden_at = null;
        comment.hidden_reason = null;
        comment.hidden_by_user_id = null;
      }
      const targetAptId = post.target_apartment_ids?.[0] || null;
      return sendJson(
        res,
        200,
        projectCommentForViewer(comment, {
          postId: post.id,
          viewerUserId: user.user_id,
          viewerRole: user.building_role,
          authorBadge: resolveAuthorBadge(comment.author_user_id, post.post_type, targetAptId),
        })
      );
    }

    // 16d. PATCH /api/v1/communication/posts/{post_id} & /comments/{comment_id} (#027)
    if (postDetailMatch && method === 'PATCH') {
      const postId = safeDecodePathParam(postDetailMatch[1]);
      const post = postId ? postsStore.find((p) => p.id === postId) : null;
      const userMems = membershipsByUser[user.user_id] || [];
      if (
        !post ||
        !canViewerSeePost(post, {
          viewerUserId: user.user_id,
          viewerRole: user.building_role,
          memberships: userMems,
        })
      ) {
        return sendError(res, 404, 'POST_NOT_FOUND', 'Post not found.');
      }
      if (post.author_user_id !== user.user_id) {
        return sendError(res, 403, 'FORBIDDEN', 'Only the author can edit this post.');
      }
      if (
        (post.post_type !== 'FORUM_TOPIC' && post.post_type !== 'BOARD_TOPIC') ||
        post.origin != null ||
        post.hidden_at
      ) {
        return sendError(res, 409, 'POST_NOT_EDITABLE', 'This post cannot be edited.', {
          post_type: post.post_type,
        });
      }
      if (post.post_type === 'FORUM_TOPIC') {
        const now = Date.now();
        if (!isWithinEditWindow(post.created_at, now)) {
          const deadlineMs = getEditWindowDeadlineMs(post.created_at);
          return sendError(
            res,
            409,
            'EDIT_WINDOW_CLOSED',
            'The 24-hour edit window has closed.',
            {
              editable_until:
                deadlineMs !== null ? new Date(deadlineMs).toISOString() : post.created_at,
            }
          );
        }
      }
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Request body must be a JSON object.');
      }
      const keys = Object.keys(body);
      if (keys.length === 0 || keys.some((k) => k !== 'title' && k !== 'body')) {
        return sendError(
          res,
          422,
          'VALIDATION_ERROR',
          'Provide title and/or body without unknown fields.'
        );
      }
      let nextTitle = post.title;
      let nextBody = post.body;
      if ('title' in body) {
        if (typeof body.title !== 'string') {
          return sendError(res, 422, 'VALIDATION_ERROR', 'Title must be a string.');
        }
        const trimmedTitle = body.title.trim();
        if (
          !trimmedTitle ||
          trimmedTitle.length > POST_TITLE_MAX_LENGTH ||
          hasDisallowedControlChars(trimmedTitle)
        ) {
          return sendError(
            res,
            422,
            'VALIDATION_ERROR',
            `Title must be 1 to ${POST_TITLE_MAX_LENGTH} plain-text characters.`
          );
        }
        nextTitle = trimmedTitle;
      }
      if ('body' in body) {
        if (typeof body.body !== 'string') {
          return sendError(res, 422, 'VALIDATION_ERROR', 'Body must be a string.');
        }
        const trimmedBody = body.body.trim();
        if (
          !trimmedBody ||
          trimmedBody.length > POST_BODY_MAX_LENGTH ||
          hasDisallowedControlChars(trimmedBody)
        ) {
          return sendError(
            res,
            422,
            'VALIDATION_ERROR',
            `Body must be 1 to ${POST_BODY_MAX_LENGTH} plain-text characters.`
          );
        }
        nextBody = trimmedBody;
      }
      if (nextTitle !== post.title || nextBody !== post.body) {
        post.title = nextTitle;
        post.body = nextBody;
        post.edited_at = new Date().toISOString();
      }
      const targetAptId = post.target_apartment_ids?.[0] || null;
      return sendJson(res, 200, {
        id: post.id,
        post_type: post.post_type,
        category: post.category,
        title: post.title,
        body: post.body,
        author_badge: resolveAuthorBadge(post.author_user_id, post.post_type, targetAptId),
        is_mine: post.author_user_id === user.user_id,
        target_scope: post.target_scope,
        target_entrance: post.target_entrance,
        target_apartment_ids: post.target_apartment_ids,
        is_active: post.is_active,
        comments_enabled: post.comments_enabled,
        comments_count: post.comments.length,
        created_at: post.created_at,
        last_activity_at:
          post.comments.length > 0
            ? post.comments[post.comments.length - 1].created_at
            : post.created_at,
        origin: post.origin || null,
        edited_at: post.edited_at || null,
        hidden_at: post.hidden_at || null,
        hidden_reason: post.hidden_at ? post.hidden_reason || null : null,
      });
    }

    const commentEditMatch = pathname.match(
      /^\/api\/v1\/communication\/posts\/([^/]+)\/comments\/([^/]+)$/
    );
    if (commentEditMatch && method === 'PATCH') {
      const postId = safeDecodePathParam(commentEditMatch[1]);
      const commentId = safeDecodePathParam(commentEditMatch[2]);
      const post = postId ? postsStore.find((p) => p.id === postId) : null;
      const userMems = membershipsByUser[user.user_id] || [];
      if (
        !post ||
        !canViewerSeePost(post, {
          viewerUserId: user.user_id,
          viewerRole: user.building_role,
          memberships: userMems,
        })
      ) {
        return sendError(res, 404, 'POST_NOT_FOUND', 'Post not found.');
      }
      const comment = commentId ? post.comments.find((c) => c.id === commentId) : null;
      if (!comment) {
        return sendError(res, 404, 'COMMENT_NOT_FOUND', 'Comment not found.');
      }
      if (comment.author_user_id !== user.user_id) {
        return sendError(res, 403, 'FORBIDDEN', 'Only the author can edit this comment.');
      }
      const editablePostType =
        post.post_type === 'FORUM_TOPIC' ||
        post.post_type === 'BOARD_TOPIC' ||
        post.post_type === 'OFFICIAL_NOTICE' ||
        post.post_type === 'EMERGENCY';
      if (!editablePostType || post.origin != null || post.hidden_at || comment.hidden_at) {
        return sendError(res, 409, 'COMMENT_NOT_EDITABLE', 'This comment cannot be edited.');
      }
      const now = Date.now();
      if (!isWithinEditWindow(comment.created_at, now)) {
        const deadlineMs = getEditWindowDeadlineMs(comment.created_at);
        return sendError(
          res,
          409,
          'EDIT_WINDOW_CLOSED',
          'The 24-hour edit window has closed.',
          {
            editable_until:
              deadlineMs !== null ? new Date(deadlineMs).toISOString() : comment.created_at,
          }
        );
      }
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Request body must be a JSON object.');
      }
      const keys = Object.keys(body);
      if (keys.length !== 1 || keys[0] !== 'body' || typeof body.body !== 'string') {
        return sendError(
          res,
          422,
          'VALIDATION_ERROR',
          'Comment body is required without unknown fields.'
        );
      }
      const check = validateCommentEdit(body.body);
      if (!check.valid) {
        return sendError(
          res,
          422,
          'VALIDATION_ERROR',
          `Comment body must be 1 to ${COMMENT_BODY_MAX_LENGTH} plain-text characters.`
        );
      }
      if (check.body !== comment.body) {
        comment.body = check.body;
        comment.edited_at = new Date().toISOString();
      }
      const targetAptId = post.target_apartment_ids?.[0] || null;
      return sendJson(
        res,
        200,
        projectCommentForViewer(comment, {
          postId: post.id,
          viewerUserId: user.user_id,
          viewerRole: user.building_role,
          authorBadge: resolveAuthorBadge(comment.author_user_id, post.post_type, targetAptId),
        })
      );
    }

    // 17. AUTH ENDPOINTS (Epic E7)

  return false;
}
