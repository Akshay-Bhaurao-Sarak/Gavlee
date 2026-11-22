const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const listingSchema = new Schema({
    title:{
        type:String,
        required:true,
    },
    description:String,
    flavours: [String],
    flavourOptions: [{
        name: { type: String, trim: true },
        price: { type: Number, min: 0 },
    }],
    hasFlavours: Boolean,
    image:String,
    price:String,
    Nutrients:String,
});

const Listing = mongoose.model("Listing",listingSchema);
module.exports=Listing;
