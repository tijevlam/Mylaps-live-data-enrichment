let rawData= "TimeR1@Passing@c=GZ59052|ct=CX|t=13:59:56.452|d=230909|l=1|dv=7|re=0|an=-1|g=-1|n=GZ59052|b=-1@c=NL25386|ct=CX|t=13:59:57.492|d=230909|l=1|dv=7|re=0|an=-1|g=-1|n=NL25386|b=-1@c=HX80374|ct=CX|t=13:59:58.388|d=230909|l=3|dv=7|re=0|an=-1|g=-1|n=HX80374|b=-1@c=FK53933|ct=CX|t=14:00:00.731|d=230909|l=1|dv=7|re=0|an=-1|g=-1|n=FK53933|b=-1@c=RL12543|ct=CX|t=14:00:02.996|d=230909|l=2|dv=7|re=0|an=-1|g=-1|n=RL12543|b=-1@c=KP59983|ct=CX|t=14:00:10.338|d=230909|l=2|dv=7|re=0|an=-1|g=-1|n=KP59983|b=-1@c=NH05685|ct=CX|t=14:00:14.247|d=230909|l=2|dv=7|re=0|an=-1|g=-1|n=NH05685|b=-1@c=FH87124|ct=CX|t=14:00:14.370|d=230909|l=1|dv=7|re=0|an=-1|g=-1|n=FH87124|b=-1@73@$"

function parsePassingMessage(data) {
    console.log("===data in parser fucntion");
    console.log(data);
    const records = data.split('@').filter(r => r.trim() !== '');
    return records.map(record => {
        const pairs = record.split('|');
        const passingData = {};
        pairs.forEach(pair => {
            const [key, value] = pair.split('=');
            passingData[key] = value;
        });
        console.log(passingData);
        return passingData;
    });
}

function parseMessage(rawMessage, socket) {
    const parts = rawMessage.split('@');
    if (parts.length < 3) {
        return { error: 'Invalid message format' };
    }

    const sourceName = parts[0];
    const function_ = parts[1];
    const data = ['Store','Passing'].includes(function_) ? parts.slice(2, -2).join('@') : parts.slice(2, -1).join('@'); // Join in case data contains '@'
    const messageNumber = ['Store','Passing'].includes(function_) ? parts[parts.length - 2] : undefined;
    // console.log(parts);
    // console.log(function_, sourceName, messageNumber, data);

    let parsedData;
    switch (function_) {
        case 'Store':
            parsedData = parseStoreMessage(data);
            break;
        case 'Passing':
            parsedData = parsePassingMessage(data);
            break;
        case 'Marker':
            parsedData = parseMarkerMessage(data);
            break;
        case 'GetInfo':
        case 'AckGetInfo':
            parsedData = parseGetInfoMessage(data);
            break;
        case 'Pong':
            parsedData = parsePongMessage(data);
            break;
        case 'AckPong':
        default:
            parsedData = { rawData: data };
    }

    // console.log("===after parser")
    // console.log(parsedData);


    return {
        sourceName: sourceName,
        function: function_,
        data: parsedData,
        messageNumber: messageNumber,
    };
}

parseMessage(rawData);