const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const listingSchema = new Schema({
    title:{
        type:String,
        required:true,
    },
    description:String,
    flavours: [String],
    image:String,
    price:String,
    Nutrients:String,
});

const Listing = mongoose.model("Listing",listingSchema);
module.exports=Listing;
