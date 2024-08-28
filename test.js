let data = [{
    "c": "KN61493",
    "ct": "CX",
    "t": "13:05:01.509",
    "d": "230909",
    "l": "1",
    "dv": "2",
    "re": "0",
    "an": "-1",
    "g": "-1",
    "n": "KN61493",
    "b": "-1"
},
{
    "c": "KN61493",
    "ct": "CX",
    "t": "13:06:30.138",
    "d": "230909",
    "l": "2",
    "dv": "2",
    "re": "0",
    "an": "-1",
    "g": "-1",
    "n": "KN61493",
    "b": "-1"
},
{
    "c": "HZ98322",
    "ct": "CX",
    "t": "13:12:09.913",
    "d": "230909",
    "l": "1",
    "dv": "2",
    "re": "0",
    "an": "-1",
    "g": "-1",
    "n": "HZ98322",
    "b": "-1"
},
{
    "c": "FF86038",
    "ct": "CX",
    "t": "13:13:23.814",
    "d": "230909",
    "l": "1",
    "dv": "2",
    "re": "0",
    "an": "-1",
    "g": "-1",
    "n": "FF86038",
    "b": "-1"
},
{
    "c": "FH83675",
    "ct": "CX",
    "t": "13:15:44.100",
    "d": "230909",
    "l": "1",
    "dv": "2",
    "re": "0",
    "an": "-1",
    "g": "-1",
    "n": "FH83675",
    "b": "-1"
},
{
    "c": "KG81954",
    "ct": "CX",
    "t": "13:16:32.578",
    "d": "230909",
    "l": "1",
    "dv": "2",
    "re": "0",
    "an": "-1",
    "g": "-1",
    "n": "KG81954",
    "b": "-1"
},
{
    "c": "PT75580",
    "ct": "CX",
    "t": "13:17:51.169",
    "d": "230909",
    "l": "1",
    "dv": "2",
    "re": "0",
    "an": "-1",
    "g": "-1",
    "n": "PT75580",
    "b": "-1"
},
{
    "c": "PL08690",
    "ct": "CX",
    "t": "13:18:22.243",
    "d": "230909",
    "l": "1",
    "dv": "2",
    "re": "0",
    "an": "-1",
    "g": "-1",
    "n": "PL08690",
    "b": "-1"
},
{
    "c": "KZ69630",
    "ct": "CX",
    "t": "13:26:16.277",
    "d": "230909",
    "l": "1",
    "dv": "2",
    "re": "0",
    "an": "-1",
    "g": "-1",
    "n": "KZ69630",
    "b": "-1"
},
{
    "c": "FP72159",
    "ct": "CX",
    "t": "13:28:01.573",
    "d": "230909",
    "l": "1",
    "dv": "2",
    "re": "0",
    "an": "-1",
    "g": "-1",
    "n": "FP72159",
    "b": "-1"
},
{
    "c": "CT20782",
    "ct": "CX",
    "t": "13:28:07.510",
    "d": "230909",
    "l": "1",
    "dv": "2",
    "re": "0",
    "an": "-1",
    "g": "-1",
    "n": "CT20782",
    "b": "-1"
},
{
    "c": "HK90325",
    "ct": "CX",
    "t": "13:28:13.875",
    "d": "230909",
    "l": "1",
    "dv": "2",
    "re": "0",
    "an": "-1",
    "g": "-1",
    "n": "HK90325",
    "b": "-1"
},
{
    "c": "CT30719",
    "ct": "CX",
    "t": "13:28:39.526",
    "d": "230909",
    "l": "1",
    "dv": "2",
    "re": "0",
    "an": "-1",
    "g": "-1",
    "n": "CT30719",
    "b": "-1"
}];


var net = require('net');
const { join } = require('node:path');
console.log("start!")
var client = new net.Socket();
console.log(join(__dirname, 'index.html'));



// client.connect(3389, '35.204.46.233', function() {
//     //client.connect(3097, 'mylaps-live-data-enrichment.onrender.com', function() {
//     //client.connect(4242, 'tcpbin.com', function() {
//
//     console.log('Connected');
//
//     //client.write('TimeR1@Pong@$');
//     client.write("TimeR1@Passing@c=GZ59052|ct=CX|t=13:59:56.452|d=230909|l=1|dv=7|re=0|an=-1|g=-1|n=GZ59052|b=-1@c=NL25386|ct=CX|t=13:59:57.492|d=230909|l=1|dv=7|re=0|an=-1|g=-1|n=NL25386|b=-1@c=HX80374|ct=CX|t=13:59:58.388|d=230909|l=3|dv=7|re=0|an=-1|g=-1|n=HX80374|b=-1@c=FK53933|ct=CX|t=14:00:00.731|d=230909|l=1|dv=7|re=0|an=-1|g=-1|n=FK53933|b=-1@c=RL12543|ct=CX|t=14:00:02.996|d=230909|l=2|dv=7|re=0|an=-1|g=-1|n=RL12543|b=-1@c=KP59983|ct=CX|t=14:00:10.338|d=230909|l=2|dv=7|re=0|an=-1|g=-1|n=KP59983|b=-1@c=NH05685|ct=CX|t=14:00:14.247|d=230909|l=2|dv=7|re=0|an=-1|g=-1|n=NH05685|b=-1@c=FH87124|ct=CX|t=14:00:14.370|d=230909|l=1|dv=7|re=0|an=-1|g=-1|n=FH87124|b=-1@73@$");
// });
//
//
//
//
// client.on('data', function(data) {
//     console.log('Received: ' + data);
//     client.destroy(); // kill client after server's response
// });
//
//
// client.on('close', function() {
//     console.log('Connection closed');
// });

const fs = require('fs');


// const bibs = fs.readFileSync('Bibs_202408280939.csv', 'utf8').split('\n').map(line => line.split(';'));

// read Bibs_202408280939.csv, convert it to valid json  with the keys in the first row and the values in the following rows and then store it in memory

const Papa = require("papaparse");
async function parseCsv(file) {
    return new Promise((resolve, reject) => {
        Papa.parse(fs.createReadStream(file), {
            header: true,
            skipEmptyLines: true,
            delimiter: ';',
            // transform: value => {
            //     return value.trim()
            // },
            complete: results => {
                return resolve(results.data)
            },
            error: error => {
                return reject(error)
            }
        })
    })
}


function matchChipToBib(bibs, chip) {
    const bib = bibs.find(bib => bib.Chip === chip);
    return bib ? bib : null;
}


async function main(){
   const bibs = await parseCsv("Bibs_202408280939.csv");
//console.log(bibs);

    for (let d of data){
        console.log(matchChipToBib(bibs, d.c));
    }

}

main();


