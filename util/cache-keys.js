const cacheKeys = {
  followRequests: (userId) => `follow:requests:v1:${userId}`,
  notificationsList: (userId) => `notifications:list:v1:${userId}`,
  notificationsUnreadCount: (userId) => `notifications:unread-count:v1:${userId}`,
  publicUsers: () => "users:public:v1",
};

export default cacheKeys;
