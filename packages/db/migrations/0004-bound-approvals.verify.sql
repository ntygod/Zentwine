SELECT (to_regclass('zentwine_approvals.requests') IS NOT NULL
 AND to_regclass('zentwine_approvals.decisions') IS NOT NULL
 AND to_regclass('zentwine_approvals.permits') IS NOT NULL
 AND to_regclass('zentwine_approvals.receipts') IS NOT NULL
 AND to_regclass('zentwine_approvals.events') IS NOT NULL
) AS verified;
