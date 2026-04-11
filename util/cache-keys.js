const cacheKeys = {
  followRequests: (userId) => `follow:requests:v1:${userId}`,
  publicUsers: () => "users:public:v1",
};

export default cacheKeys;
