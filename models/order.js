const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema({
    reference: { type: String, required: true, unique: true },
    items: [{
        listing: { type: mongoose.Schema.Types.ObjectId, ref: "Listing", required: true },
        title: { type: String, required: true },
        image: String,
        flavour: String,
        quantity: { type: Number, min: 1, required: true },
        unitPrice: { type: Number, min: 0, required: true },
    }],
    customer: {
        name: { type: String, required: true },
        phone: { type: String, default: "" },
        email: String,
    },
    fulfillment: { type: String, enum: ["delivery", "pickup"], required: true },
    address: { type: String, default: "" },
    paymentMethod: { type: String, enum: ["cod", "pay-at-store", "online"], required: true },
    subtotal: { type: Number, required: true },
    gst: { type: Number, required: true },
    shipping: { type: Number, required: true },
    total: { type: Number, required: true },
    status: { type: String, default: "placed" },
    razorpayOrderId: String,
    razorpayPaymentId: String,
}, { timestamps: true });

module.exports = mongoose.model("Order", orderSchema);
