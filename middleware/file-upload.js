const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const multer = require("multer");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// For user images
const userImageStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "user_images", // Specify the folder for user images
    allowed_formats: ["jpeg", "png", "jpg"],
  },
});

// For place images
const placeImageStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "place_images", // Specify the folder for place images
    allowed_formats: ["jpeg", "png", "jpg"],
  },
});

// Multer middleware for user image upload
const uploadUserImage = multer({ storage: userImageStorage });

// Multer middleware for place image upload
const uploadPlaceImage = multer({ storage: placeImageStorage });

module.exports = { uploadUserImage, uploadPlaceImage };

// const multer = require("multer");
// const { v4: uuid } = require("uuid");

// const MIME_TYPE_MAP = {
//   "image/png": "png",
//   "image/jpeg": "jpeg",
//   "image/jpg": "jpg",
// };

// const fileUpload = multer({
//   limits: 500000,
//   storage: multer.diskStorage({
//     destination: (req, file, cb) => {
//       cb(null, "uploads/images");
//     },
//     filename: (req, file, cb) => {
//       const ext = MIME_TYPE_MAP[file.mimetype];
//       cb(null, uuid() + "." + ext);
//     },
//   }),
//   fileFilter: (req, file, cb) => {
//     const isValid = !!MIME_TYPE_MAP[file.mimetype];
//     let error = isValid ? null : new Error("Invalid mime type!");
//     cb(error, isValid);
//   },
// });

// module.exports = fileUpload;
