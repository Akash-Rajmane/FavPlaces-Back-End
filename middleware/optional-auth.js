const jwt = require("jsonwebtoken");

module.exports = (req, res, next) => {
  if (req.method === "OPTIONS") {
    return next();
  }

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return next(); // ✅ no token, continue anonymously
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return next();
    }

    const decodedToken = jwt.verify(token, process.env.JWT_KEY);
    req.userData = { userId: decodedToken.userId };
  } catch (err) {
    // ❌ ignore token errors for public routes
  }

  next();
};
